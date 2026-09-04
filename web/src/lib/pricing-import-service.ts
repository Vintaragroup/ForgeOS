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
import { AlreadyImportedError } from "@/lib/import-errors";
import { db } from "@/lib/db";
import { cellText } from "@/lib/xlsx-utils";
import { PDF_MIME } from "@/lib/ai/text-extraction";
import { loadCatalogForMatching, matchDescription, type CatalogMatch } from "@/lib/catalog-match-service";
import { inferIsClientOwned, resolveComposedCategory } from "@/lib/line-item-category";
import {
  commitDesignCostEstimateImport,
  findDesignCostEstimateSheet,
  previewDesignCostEstimateImport,
  type DesignCostEstimatePreview,
} from "@/lib/design-cost-estimate-import-service";
import {
  commitModuleCostEstimateImport,
  findModuleCostEstimateSheets,
  previewModuleCostEstimateImport,
  type ModuleCostEstimatePreview,
} from "@/lib/module-cost-estimate-import-service";
import {
  commitAiProposedImport,
  previewAiProposedImport,
  type AiProposedImportPreview,
  type SheetDestination,
} from "@/lib/ai/spreadsheet-line-item-service";
import {
  commitStandaloneVendorQuoteImport,
  previewStandaloneVendorQuoteImport,
  type StandaloneVendorQuoteImportPreview,
} from "@/lib/ai/vendor-quote-service";

const HEADER_SCAN_ROWS = 20; // header always appears near the top, after a title/merge block

export interface ParsedPricingRow {
  rowNumber: number;
  category: string;
  item: string | null;
  // Human-facing text -- combines item + the Description/Notes cell when
  // both are present and actually differ (see the row-parsing loop's own
  // comment on why: a real production import had 11 different booth
  // positions all landing on the literal same "Sleeper floor required"
  // note text with no way to tell them apart in the match-review
  // dropdown, because their real distinguishing name -- the Item column
  // -- was being discarded once Description had ANY content at all).
  description: string;
  // The exact source text this row cites for LineItem.sourceQuote's own
  // citation-highlight guarantee -- kept separate from `description`
  // specifically because it must stay a single, verbatim, one-real-cell
  // value, whereas `description` above may now be a synthesized
  // combination of two cells.
  sourceQuote: string;
  unit: string;
  qty: number;
  catalogMatch: CatalogMatch | null;
  // A vendor/RFP-assigned position code for this exact row (e.g.
  // "CAM-01"), when the sheet has a Ref./Reference column -- see
  // LineItem.positionCode's own schema comment. Null when the sheet has
  // no such column, or the cell is blank for this row.
  positionCode: string | null;
}

export interface PricingImportPreview {
  // See DesignCostEstimatePreview's own comment on this field -- lets
  // previewPricingImport's dispatcher return a union of the two shapes
  // and page.tsx pick the right table.
  kind: "pricing-schedule";
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
  // A "Ref."/"Reference" column holding the vendor's own position code
  // for each row (e.g. "CAM-01") -- optional, unlike the required
  // columns above, since most pricing schedules don't have one. See
  // LineItem.positionCode's own schema comment for what this unlocks.
  refCode: number | null;
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
  let refCode: number | null = null;

  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = normalizeHeader(cell.value);
    // Known label variants actually observed across real client RFP
    // templates in data/RFP/superbowl (Arena's own revised schedule uses
    // "Notes"/"Planning Qty"/"Location / Item" instead of this sheet's
    // usual "Description"/"Qty"/"Item") -- kept as an explicit alias list,
    // not fuzzy/substring matching, so this only widens to wording
    // actually seen in the wild rather than guessing at one.
    if (text === "category") category = colNumber;
    else if (text === "description" || text === "notes") description = colNumber;
    else if (text === "unit") unit = colNumber;
    else if (text === "qty" || text === "planning qty") qty = colNumber;
    else if (item === null && (text.startsWith("item") || text === "location / item")) item = colNumber;
    else if (refCode === null && (text === "ref." || text === "ref" || text === "reference")) refCode = colNumber;
  });

  if (category === null || description === null || unit === null || qty === null) return null;
  return { category, item, description, unit, qty, refCode };
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
export async function previewPricingImport(
  documentId: string,
  opportunityId: string,
  userId: string | null = null,
): Promise<
  | PricingImportPreview
  | DesignCostEstimatePreview
  | ModuleCostEstimatePreview
  | AiProposedImportPreview
  | StandaloneVendorQuoteImportPreview
> {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  // A vendor-quote PDF (e.g. a booth graphics vendor's own itemized
  // quote) has no workbook to load at all -- ExcelJS.Workbook().xlsx.load
  // below would throw immediately on a PDF's bytes. Checked first, before
  // that call, not as a catch-and-retry: this is a real, known shape
  // (documentType VENDOR_QUOTE + a PDF mimeType), not a fallback for an
  // unrecognized one the way the AI-proposed spreadsheet path is.
  if (document.documentType === "VENDOR_QUOTE" && document.mimeType === PDF_MIME) {
    return previewStandaloneVendorQuoteImport(documentId, opportunityId, userId);
  }

  const workbook = new ExcelJS.Workbook();
  // exceljs's own Buffer type comes from a slightly different @types/node
  // generation than this project's -- structurally identical at runtime,
  // so this is a type-level mismatch only, not a real conversion.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  // Tried first, before this importer's own flat-schedule detection --
  // the two shapes are distinct enough (see detectDesignCostEstimateSheet's
  // own comment) that this never misfires on a real flat pricing schedule.
  // Keeps this one function/one "Preview import" button the uploader ever
  // sees, regardless of which of the two shapes their file turns out to
  // be -- they still just tag it "Pricing schedule" as usual.
  if (findDesignCostEstimateSheet(workbook)) {
    return previewDesignCostEstimateImport(documentId, opportunityId);
  }

  // Tried right after the Design Cost Estimate shape -- both are banner-
  // based itemized shapes, this one distinct enough (its own "Sheet
  // Goods"/"Other Items"/"Labor" column-1 banners) that it never
  // conflicts with that detector or the flat-schedule one below.
  if (findModuleCostEstimateSheets(workbook).length > 0) {
    return previewModuleCostEstimateImport(documentId, opportunityId);
  }

  const found = findPricingSheet(workbook);
  if (!found) {
    // Neither deterministic shape recognized this file -- confirmed
    // necessary against two more real vendor formats (see
    // spreadsheet-line-item-service.ts's own header comment) rather than
    // dead-ending the estimate on a format nobody's hand-written a parser
    // for yet. Always tried last: deterministic parsing stays preferred
    // wherever a shape is actually known.
    return previewAiProposedImport(documentId, opportunityId, userId);
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
    const item = columns.item ? cellText(row.getCell(columns.item).value) || null : null;
    const rawDescription = cellText(row.getCell(columns.description).value);
    // Some RFP shapes (e.g. Arena's own template) put the row's real
    // identifying text in the Item column -- "Right Endzone Camera
    // Platform" -- and leave Description blank except for a supplementary
    // note on a handful of rows; others put a generic, repeated note in
    // Description ("Sleeper floor required") while Item holds the real,
    // DISTINGUISHING location name. Confirmed live on a real production
    // import: 11 different booth positions all landed on the literal same
    // "Sleeper floor required" text with no way to tell them apart in the
    // match-review dropdown, because Item's own text was discarded
    // outright whenever Description had ANY content. Combines both when
    // they're both present and actually differ, falls back to whichever
    // one exists when only one does (verified live: without a fallback at
    // all, 78 of Arena-template.xlsx's 96 candidate rows were silently
    // dropped as spacer rows below).
    const description =
      item && rawDescription && item !== rawDescription ? `${item} — ${rawDescription}` : rawDescription || item || "";
    // The citation-highlight anchor (LineItem.sourceQuote) must stay a
    // single, verbatim, one-real-cell value even when `description` above
    // is a synthesized combination of two cells -- whichever field
    // actually has content, same resolution order as before this file
    // started combining the two for display.
    const sourceQuote = rawDescription || item || "";
    const qtyRaw = row.getCell(columns.qty).value;
    const qty = typeof qtyRaw === "number" ? qtyRaw : Number(cellText(qtyRaw));

    // A blank description is a spacer row, not a line item. Qty legitimately
    // includes 0 (Exhibit 1's own instructions: "Unit Rates must be
    // provided even where the quantity is zero"), so only NaN disqualifies.
    if (!description || Number.isNaN(qty)) continue;

    const category = cellText(row.getCell(columns.category).value) || lastCategory;
    lastCategory = category;
    const positionCode = columns.refCode ? cellText(row.getCell(columns.refCode).value) || null : null;

    rows.push({
      rowNumber,
      category,
      item,
      description,
      sourceQuote,
      unit: cellText(row.getCell(columns.unit).value),
      qty,
      // description already combines item + notes when both are real and
      // distinct (see above), so it alone is the right catalog-matching
      // input now -- no separate item/description concatenation needed.
      catalogMatch: matchDescription(description, catalog),
      positionCode,
    });
  }

  return {
    kind: "pricing-schedule",
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
export async function commitPricingImport(
  estimateVersionId: string,
  documentId: string,
  sheetDestinations?: Record<string, SheetDestination>,
) {
  // Derived fresh from estimateVersionId, not a redundant caller-supplied
  // parameter -- see previewPricingImport's own header comment for why
  // this check exists at all.
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });
  const preview = await previewPricingImport(documentId, version.estimate.opportunityId);
  // Same dispatch as previewPricingImport's own -- re-derives its preview
  // internally rather than taking this one as a param, same "derive
  // fresh, don't trust a caller-passed preview" posture this function
  // already applies to opportunityId above.
  if (preview.kind === "design-cost-estimate") {
    return commitDesignCostEstimateImport(estimateVersionId, documentId);
  }
  if (preview.kind === "module-cost-estimate") {
    return commitModuleCostEstimateImport(estimateVersionId, documentId);
  }
  if (preview.kind === "ai-proposed") {
    return commitAiProposedImport(estimateVersionId, documentId, sheetDestinations);
  }
  if (preview.kind === "vendor-quote") {
    return commitStandaloneVendorQuoteImport(estimateVersionId, documentId);
  }
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
    throw new AlreadyImportedError(preview.filename);
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
        category: resolveComposedCategory(
          {
            catalogCategory: row.catalogMatch?.category,
            catalogSource: row.catalogMatch?.source,
            description: row.description,
          },
          categories,
        ),
        isClientOwned: inferIsClientOwned(row.description),
        documentId,
        // A single real cell's own text, verbatim -- exactly what the
        // spreadsheet viewer renders in that cell, so the "Source" link's
        // highlight (document-view-service.ts's highlightSpreadsheetCell)
        // always finds a real, exact match. Deliberately NOT row.description,
        // which may now be a synthesized combination of two cells -- see
        // ParsedPricingRow's own comment on why the two are kept separate.
        sourceQuote: row.sourceQuote,
        positionCode: row.positionCode,
      })),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: preview.rows.length };
}
