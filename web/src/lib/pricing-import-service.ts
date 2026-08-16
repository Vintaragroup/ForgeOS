// Phase 7.1: deterministic parser for the "Pricing Schedule" XLSX shape
// used by real RFP financial proposal exhibits -- see data/RFP/superbowl,
// both packages' Exhibit 1 files share an identical 12-column header
// (Commodity/Category/Item/Description/Unit/Qty/Historical Qty's/
// In-House Inventory/Unit Rate (USD)/Total Price (USD)/Comments/
// Supporting Document Ref) even though the exact wording of "Item" and
// column offsets differ slightly between them. Detection matches header
// TEXT, not filename or exact column position, so this generalizes to
// other clients' similarly-shaped sheets rather than being hardcoded to
// this one template.
//
// Deliberately NOT an AI extraction -- these rows already carry qty and
// description; an LLM would be strictly worse than just reading the cells.

import ExcelJS from "exceljs";
import { getDocumentBytes } from "@/lib/document-service";
import { addLineItemsBulk, findOrCreateSection } from "@/lib/estimate-service";
import { db } from "@/lib/db";
import { cellText } from "@/lib/xlsx-utils";
import { loadCatalogForMatching, matchDescription, type CatalogMatch } from "@/lib/catalog-match-service";
import { inferIsClientOwned, resolveLineItemCategory } from "@/lib/line-item-category";

const HEADER_SCAN_ROWS = 20; // header always appears near the top, after a title/merge block

export interface ParsedPricingRow {
  rowNumber: number;
  category: string;
  item: string | null;
  description: string;
  unit: string;
  qty: number;
  catalogMatch: CatalogMatch | null;
}

export interface PricingImportPreview {
  documentId: string;
  filename: string;
  sheetName: string;
  rows: ParsedPricingRow[];
  categories: string[];
}

function normalizeHeader(value: unknown): string {
  // Must go through cellText, not String(value) directly -- a header
  // cell can be richText (e.g. "Item (Page Reference to Appendix B)" in
  // a real Super Bowl schedule, styled with mixed run formatting), which
  // String() stringifies to the useless literal "[object Object]"
  // instead of its actual text.
  return cellText(value).replace(/\s+/g, " ").trim().toLowerCase();
}

interface ColumnMap {
  category: number;
  item: number | null;
  description: number;
  unit: number;
  qty: number;
}

// A row counts as THE header row only when category/description/unit/qty
// are all present as distinct columns -- that combination is specific
// enough to a pricing schedule that it won't false-positive on other
// sheets (e.g. the "1. Instructions & Summary" sheet in the same workbook).
function findColumnMap(row: ExcelJS.Row): ColumnMap | null {
  let category: number | null = null;
  let item: number | null = null;
  let description: number | null = null;
  let unit: number | null = null;
  let qty: number | null = null;

  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = normalizeHeader(cell.value);
    if (text === "category") category = colNumber;
    else if (text === "description") description = colNumber;
    else if (text === "unit") unit = colNumber;
    else if (text === "qty") qty = colNumber;
    else if (item === null && text.startsWith("item")) item = colNumber;
  });

  if (category === null || description === null || unit === null || qty === null) return null;
  return { category, item, description, unit, qty };
}

function findPricingSheet(
  workbook: ExcelJS.Workbook,
): { sheet: ExcelJS.Worksheet; headerRowNumber: number; columns: ColumnMap } | null {
  for (const sheet of workbook.worksheets) {
    for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount); rowNumber++) {
      const columns = findColumnMap(sheet.getRow(rowNumber));
      if (columns) return { sheet, headerRowNumber: rowNumber, columns };
    }
  }
  return null;
}

// opportunityId is the caller's already-access-checked opportunity (from
// requireEstimateAccess, via opportunity-access.ts's estimateOpportunityId
// when only an estimateId is in scope), NOT trusted from documentId
// alone -- getDocumentBytes has no ownership concept of its own (see its
// own callers, e.g. the raw-byte-serving route, for why each caller
// checks independently). Without this, estimates/[id]/page.tsx's own
// ?importDocumentId=<id> query param (read directly from searchParams)
// could preview -- and, via commitPricingImport below, commit -- a
// DIFFERENT opportunity's pricing schedule into an estimate the caller
// was never authorized to see that document under.
export async function previewPricingImport(documentId: string, opportunityId: string): Promise<PricingImportPreview> {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  const workbook = new ExcelJS.Workbook();
  // exceljs's own Buffer type comes from a slightly different @types/node
  // generation than this project's -- structurally identical at runtime,
  // so this is a type-level mismatch only, not a real conversion.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const found = findPricingSheet(workbook);
  if (!found) {
    throw new Error(
      `"${document.filename}" doesn't contain a recognizable Pricing Schedule sheet (expected Category/Description/Unit/Qty columns).`,
    );
  }
  const { sheet, headerRowNumber, columns } = found;

  // Loaded once, outside the row loop -- matching is a pure in-memory
  // scoring pass against a handful of catalog rows (see
  // catalog-match-service.ts), not worth a query per row.
  const catalog = await loadCatalogForMatching();

  const rows: ParsedPricingRow[] = [];
  let lastCategory = "";
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const description = cellText(row.getCell(columns.description).value);
    const qtyRaw = row.getCell(columns.qty).value;
    const qty = typeof qtyRaw === "number" ? qtyRaw : Number(cellText(qtyRaw));

    // A blank description is a spacer row, not a line item. Qty legitimately
    // includes 0 (Exhibit 1's own instructions: "Unit Rates must be
    // provided even where the quantity is zero"), so only NaN disqualifies.
    if (!description || Number.isNaN(qty)) continue;

    const category = cellText(row.getCell(columns.category).value) || lastCategory;
    lastCategory = category;
    const item = columns.item ? cellText(row.getCell(columns.item).value) || null : null;

    rows.push({
      rowNumber,
      category,
      item,
      description,
      unit: cellText(row.getCell(columns.unit).value),
      qty,
      catalogMatch: matchDescription(item ? `${item} ${description}` : description, catalog),
    });
  }

  return {
    documentId,
    filename: document.filename,
    sheetName: sheet.name,
    rows,
    categories: [...new Set(rows.map((r) => r.category))],
  };
}

// Real pricing schedules identify which booth/exhibit instance a row
// belongs to via the Item column (header: "Item (Page Reference to
// Appendix B)"), always as "Section ### - ..." on every booth-labeled row
// observed across real Super Bowl jobs -- confirmed against Appendix B's
// own CAD bid set, which labels the matching drawings the same way
// ("SECTION 203", "SECTION 211", etc). Rows where the Item column holds
// something else entirely (e.g. the ADD-ON alternates sub-table reusing
// that column for an alternate system's own name) don't match, and fall
// back to today's flat category-only grouping -- this pattern only ever
// promotes a section into a booth group, never demotes or hides one.
const BOOTH_ITEM_PATTERN = /^Section\s+\d+/i;

// Friendly sub-section labels for the category codes actually observed in
// real Super Bowl pricing schedules -- anything else falls back to the
// raw category string rather than guess at a naming convention we haven't
// seen real data for.
const CATEGORY_LABELS: Record<string, string> = {
  BOOTH_PLATFORM: "Platform",
  CAMERA_PLATFORM: "Platform",
  TemporaryBooth_BUILD: "Booth Build",
  "TemporaryBooth_ADD ON": "Add-Ons & Alternates",
  TemporaryBooth_SERVICE: "Show Services",
};

function humanizeCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

// Creates one EstimateSection per distinct (booth, category) pair -- a
// real pricing schedule collapses ~185 rows into ~15 booths x a handful
// of categories each (Booth Build/Platform), plus a couple of
// booth-independent categories (Add-Ons, Show Services). Booth-labeled
// sections share a groupLabel so the proposal can render them as one
// "Section 203 - Booth" heading with Booth Build/Platform underneath it,
// instead of one giant flat "Platform" section mixing all 15 booths'
// platforms together. Every row still becomes an isDraft LineItem
// pointing back at the source Document -- the same review-before-it-
// counts gate as attachmentId-sourced drafts. The Pricing Schedule's own
// Unit Rate column is blank by design (that's the bidder's job to fill
// in), not something to guess at wholesale -- but where a row's
// description confidently matches a real catalog entry (see
// catalog-match-service.ts, shown to the reviewer in the preview table
// before they ever click Commit), that rate seeds unitCost instead of
// leaving every single row at $0. Still isDraft, still requires the
// existing confirm-before-it-counts step either way.
export async function commitPricingImport(estimateVersionId: string, documentId: string) {
  // Derived fresh from estimateVersionId, not a redundant caller-supplied
  // parameter -- see previewPricingImport's own header comment for why
  // this check exists at all.
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });
  const preview = await previewPricingImport(documentId, version.estimate.opportunityId);
  if (preview.rows.length === 0) {
    throw new Error(`No line items found in "${preview.filename}".`);
  }

  // Not just a nicety -- this ran twice on the exact same document for a
  // real job before this check existed, silently doubling every section
  // and line item (and the dollar total, once confirmed). Nothing here
  // reconciles an existing import against a changed source file; a
  // re-import must go through deleting the old rows first, deliberately,
  // not by re-clicking the same button.
  const alreadyImported = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  if (alreadyImported) {
    throw new Error(
      `"${preview.filename}" has already been imported into this estimate. Delete its existing line items first if you want to re-import.`,
    );
  }

  const existingSectionCount = await db.estimateSection.count({
    where: { estimateVersionId, optionId: null },
  });
  const categories = await db.category.findMany({ where: { deletedAt: null } });

  const groupKey = (row: ParsedPricingRow) => {
    const boothLabel = row.item && BOOTH_ITEM_PATTERN.test(row.item) ? row.item : null;
    return { boothLabel, category: row.category, key: `${boothLabel ?? ""}\u0000${row.category}` };
  };

  const seenKeys = new Set<string>();
  const groups: { boothLabel: string | null; category: string }[] = [];
  for (const row of preview.rows) {
    const { boothLabel, category, key } = groupKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    groups.push({ boothLabel, category });
  }

  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const group of groups) {
    // Reuses an existing (name, groupLabel) section in this version
    // instead of creating a duplicate -- matters once a version can
    // receive more than one pricing-schedule import (see
    // estimate-synthesis-service.ts).
    const section = await findOrCreateSection(estimateVersionId, {
      name: humanizeCategory(group.category),
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
      groupLabel: group.boothLabel,
    });

    const rowsForGroup = preview.rows.filter((r) => groupKey(r).key === `${group.boothLabel ?? ""}\u0000${group.category}`);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      rowsForGroup.map((row) => ({
        lineType: "MATERIAL" as const,
        description: row.description,
        qty: row.qty,
        unit: row.unit || null,
        unitCost: row.catalogMatch?.unitCost ?? 0,
        category: resolveLineItemCategory(
          { catalogCategory: row.catalogMatch?.category, description: row.description },
          categories,
        ),
        isClientOwned: inferIsClientOwned(row.description),
        documentId,
        // The Description cell's own text, verbatim -- exactly what the
        // spreadsheet viewer renders in that cell, so the "Source" link's
        // highlight (document-view-service.ts's highlightSpreadsheetCell)
        // always finds a real, exact match.
        sourceQuote: row.description,
      })),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: preview.rows.length };
}
