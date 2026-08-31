// Deterministic parser for the "DESIGN COST ESTIMATE" booth workbook shape
// -- a per-booth engineering/pricing template (confirmed live against
// data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering,
// 13 real files) that's structurally unrelated to pricing-import-service.ts's
// flat Category/Description/Unit/Qty schedule: no header cell ever says
// "Category" at all -- categories only exist as indented banner rows
// ("   BeMatrix", "   Wall Panels") interleaved with real item rows under
// ONE header (Qty/Type-Part-Number/Sq. Ft./Description/Unit Cost/Total
// Cost/Markup/Retail/Job Cost). Auto-detected and dispatched to from
// pricing-import-service.ts, so this is invisible to the uploader -- they
// still just tag the file "Pricing schedule" as usual.

import ExcelJS from "exceljs";
import { getDocumentBytes } from "@/lib/document-service";
import { addLineItemsBulk, findOrCreateSection } from "@/lib/estimate-service";
import { db } from "@/lib/db";
import { cellText } from "@/lib/xlsx-utils";
import { loadCatalogForMatching, matchDescription, type CatalogMatch } from "@/lib/catalog-match-service";
import {
  inferCategoryFromDescription,
  inferIsClientOwned,
  isAlwaysGraphicsDescription,
  mapCatalogCategoryToCanonical,
  mapDesignCostCategoryToCanonical,
  resolveCategoryNameFromKey,
} from "@/lib/line-item-category";

const TITLE_SCAN_ROWS = 10; // "DESIGN COST ESTIMATE" + "Build Name:" always appear in the first few rows
const HEADER_SCAN_ROWS = 35; // the item-table header (row 30 in every real file seen) comes after a longer disclaimer block than pricing-import-service.ts's own sheets

export interface ParsedDesignCostRow {
  rowNumber: number;
  category: string; // the nearest preceding banner row's own text (e.g. "BeMatrix", "Wall Panels")
  description: string;
  sourceQuote: string;
  qty: number;
  // The sheet's own Total Cost/Retail cells are formula results and NOT
  // trustworthy on their own -- confirmed live, one real file (Section
  // 203) has several rows/subtotals sitting at #VALUE! because of blank
  // Sq. Ft. cells feeding a `qty * sqFt * unitCost` formula elsewhere in
  // the same workbook. unitCost here is the row's own real Unit Cost cell
  // with the Sq. Ft. multiplier already folded in (see foldSqFtIntoUnitCost
  // below) -- this app's own LineItem total is always qty * unitCost, no
  // separate multiplier field, so this is the only way to land on the
  // sheet's true per-piece total without inheriting its broken formula
  // chain.
  unitCost: number;
  catalogMatch: CatalogMatch | null;
}

export interface DesignCostEstimatePreview {
  // Discriminant letting pricing-import-service.ts's dispatcher return a
  // union of this shape and its own PricingImportPreview, and letting
  // page.tsx's render pick the right table without a second, separate
  // "which importer ran" flag.
  kind: "design-cost-estimate";
  documentId: string;
  filename: string;
  sheetName: string;
  // Verbatim "Build Name:" field -- the one signal in this template that
  // two independently-uploaded booth workbooks are the SAME design (one
  // copied wholesale from another, or re-quantified from it) rather than
  // independently engineered. Null only if the label row itself is
  // missing, which detectDesignCostEstimateSheet already requires to
  // exist for this parser to run at all.
  buildName: string | null;
  // The section number this booth is labeled with in its OWN filename
  // (e.g. "SUPER BOWL A 6.3.0 SECTION 211 - Estimate...xlsx" -> "Section
  // 211") -- nothing inside the workbook itself states this, only the
  // filename does across all 13 real files checked. Falls back to
  // buildName when the filename doesn't match, so grouping still works
  // for a differently-named file.
  boothLabel: string | null;
  rows: ParsedDesignCostRow[];
  categories: string[];
}

// Distinct enough from pricing-import-service.ts's own flat-schedule
// detection (Category/Description/Unit/Qty header) that the two never
// both match the same sheet -- confirmed against all 13 real files and
// against the existing Exhibit 1 pricing-schedule fixtures used by that
// importer's own tests.
export function detectDesignCostEstimateSheet(sheet: ExcelJS.Worksheet): boolean {
  let hasTitle = false;
  let hasBuildNameLabel = false;
  for (let rowNumber = 1; rowNumber <= Math.min(TITLE_SCAN_ROWS, sheet.rowCount); rowNumber++) {
    const row = sheet.getRow(rowNumber);
    for (let col = 1; col <= 10; col++) {
      const text = cellText(row.getCell(col).value).toUpperCase();
      if (text === "DESIGN COST ESTIMATE") hasTitle = true;
      if (text === "BUILD NAME:") hasBuildNameLabel = true;
    }
    if (hasTitle && hasBuildNameLabel) return true;
  }
  return false;
}

export function findDesignCostEstimateSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | null {
  for (const sheet of workbook.worksheets) {
    if (detectDesignCostEstimateSheet(sheet)) return sheet;
  }
  return null;
}

function readBuildName(sheet: ExcelJS.Worksheet): string | null {
  for (let rowNumber = 1; rowNumber <= Math.min(TITLE_SCAN_ROWS, sheet.rowCount); rowNumber++) {
    const row = sheet.getRow(rowNumber);
    for (let col = 1; col <= 10; col++) {
      if (cellText(row.getCell(col).value).toUpperCase() === "BUILD NAME:") {
        // The value lives in the next real (merged) cell to the right --
        // walk forward past any blank cells belonging to the same merge.
        for (let valueCol = col + 1; valueCol <= col + 4; valueCol++) {
          const value = cellText(row.getCell(valueCol).value);
          if (value) return value;
        }
      }
    }
  }
  return null;
}

// The item-table header row itself never has a "Category" column (unlike
// pricing-import-service.ts's shape) -- detected instead by the presence
// of "Qty" and "Description" as distinct column headers close together,
// which is specific enough not to false-positive on the disclaimer text
// block that precedes it.
function findHeaderRow(sheet: ExcelJS.Worksheet): { rowNumber: number; qtyCol: number; typeCol: number; sqFtCol: number; descCol: number; unitCostCol: number } | null {
  for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount); rowNumber++) {
    const row = sheet.getRow(rowNumber);
    let qtyCol: number | null = null;
    let typeCol: number | null = null;
    let sqFtCol: number | null = null;
    let descCol: number | null = null;
    let unitCostCol: number | null = null;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellText(cell.value).trim().toLowerCase();
      if (text === "qty") qtyCol = colNumber;
      else if (text === "type/part number") typeCol = colNumber;
      else if (text === "sq. ft." || text === "sq ft") sqFtCol = colNumber;
      else if (text === "description") descCol = colNumber;
      else if (text === "unit cost") unitCostCol = colNumber;
    });
    if (qtyCol !== null && descCol !== null && unitCostCol !== null) {
      return { rowNumber, qtyCol, typeCol: typeCol ?? qtyCol + 1, sqFtCol: sqFtCol ?? qtyCol + 2, descCol, unitCostCol };
    }
  }
  return null;
}

// A row is a category BANNER when its own first cell holds real text
// (e.g. "   BeMatrix", "Exhibit Components:", "Labor:") -- confirmed live,
// every one of these is a merged cell spanning the item columns, so
// reading just column 1 is reliable. An ITEM row's first cell is always
// blank/whitespace, with the real Qty living in the header's own Qty
// column instead. This distinction matters because item rows are read
// with completely different columns than banner rows (banner rows carry
// a subtotal in the Total-Cost-mapped column that must NOT be read as an
// item's own Qty).
function isBannerRow(row: ExcelJS.Row): boolean {
  return cellText(row.getCell(1).value).trim().length > 0;
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cellText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// A genuine BeMatrix part number always has 2+ separate digit runs (e.g.
// "606 0310 0434", "614 2418 S04 TG") -- confirmed live against the real
// Type/Part Number column, which also holds pure category-label
// placeholders with zero digits at all ("Wall Panel", "AV", "LIGHTING",
// "Miscellaneous") for rows that were never assigned a real SKU. Requiring
// two digit runs (not "contains a digit") also correctly rejects those
// placeholders without needing to hardcode the specific label strings,
// which vary by file's own Graphic Panels section.
const REAL_PART_NUMBER_PATTERN = /\d{2,}.*\d{2,}/;

export interface DesignCostReconciliationRow {
  rowNumber: number;
  // The raw Type/Part Number cell text -- kept alongside the parsed
  // `partNumber` so a caller can also recognize genuine "Wall Panel" rows
  // (the only ones with a real, CAD-comparable Sq. Ft. value; "Graphic
  // Panels" section rows reuse this same Sq. Ft. column as a meaningless
  // "1" placeholder, confirmed live).
  type: string;
  partNumber: string | null;
  description: string;
  qty: number;
  sqFt: number | null;
}

// Reads the two columns previewDesignCostEstimateImport deliberately
// doesn't retain (Type/Part Number as a real SKU, and Sq. Ft. as its own
// value rather than folded into unitCost) -- built for
// cad-reconciliation-service.ts's CAD-Pull-Sheet-vs-Excel-quote audit,
// entirely separate from previewDesignCostEstimateImport's own row loop
// so that tested, already-live import path is unaffected.
export async function readDesignCostRowsForReconciliation(
  workbook: ExcelJS.Workbook,
): Promise<DesignCostReconciliationRow[]> {
  const sheet = findDesignCostEstimateSheet(workbook);
  if (!sheet) return [];
  const header = findHeaderRow(sheet);
  if (!header) return [];

  const rows: DesignCostReconciliationRow[] = [];
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (isBannerRow(row)) continue;

    const qty = numericOrNull(row.getCell(header.qtyCol).value);
    if (qty === null) continue;

    const type = cellText(row.getCell(header.typeCol).value);
    const description = cellText(row.getCell(header.descCol).value) || type;
    if (!description) continue; // spacer row, same fallback as previewDesignCostEstimateImport

    rows.push({
      rowNumber,
      type,
      partNumber: REAL_PART_NUMBER_PATTERN.test(type) ? type : null,
      description,
      qty,
      sqFt: numericOrNull(row.getCell(header.sqFtCol).value),
    });
  }
  return rows;
}

export async function previewDesignCostEstimateImport(
  documentId: string,
  opportunityId: string,
): Promise<DesignCostEstimatePreview> {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const sheet = findDesignCostEstimateSheet(workbook);
  if (!sheet) {
    throw new Error(`"${document.filename}" doesn't look like a Design Cost Estimate booth workbook.`);
  }
  const header = findHeaderRow(sheet);
  if (!header) {
    throw new Error(`"${document.filename}" is a Design Cost Estimate workbook but its item table header couldn't be found.`);
  }

  const buildName = readBuildName(sheet);
  const sectionMatch = document.filename.match(/SECTION\s+\d+/i);
  const boothLabel = sectionMatch ? sectionMatch[0].replace(/\s+/g, " ").toUpperCase() : buildName;

  const catalog = await loadCatalogForMatching();

  const rows: ParsedDesignCostRow[] = [];
  let currentCategory = "";
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);

    if (isBannerRow(row)) {
      // Strip the template's own leading indentation ("   BeMatrix" ->
      // "BeMatrix") -- purely cosmetic, doesn't change matching.
      currentCategory = cellText(row.getCell(1).value).trim();
      continue;
    }

    const qty = numericOrNull(row.getCell(header.qtyCol).value);
    if (qty === null) continue; // neither a banner nor a real item row -- a fully blank spacer

    const type = cellText(row.getCell(header.typeCol).value);
    const rawDescription = cellText(row.getCell(header.descCol).value);
    // Same item-or-description fallback pricing-import-service.ts already
    // established (see its own ParsedPricingRow comment) -- a handful of
    // real rows here (e.g. the Labor:/Warehouse row) have a real Type
    // value ("Warehouse") but a BLANK Description cell; without this
    // fallback they'd be wrongly dropped as spacer rows despite carrying
    // a real, priced quantity.
    const description = rawDescription || type || "";
    if (!description) continue; // a genuine spacer/placeholder row (e.g. an empty Electrical/Cleaning stub), qty is 0 either way

    const sqFtRaw = numericOrNull(row.getCell(header.sqFtCol).value);
    // Confirmed live against the real formulas (not guessed from the
    // numbers alone): BeMatrix frame/connector rows compute
    // `qty * unitCost` (their own Sq. Ft. cell is blank, i.e. a 1x
    // no-op multiplier); Wall Panel/Graphic Panel rows compute
    // `qty * sqFt * unitCost`. Folding a present, positive Sq. Ft. value
    // into unitCost here reproduces the sheet's true per-piece cost
    // under this app's own qty*unitCost-only LineItem total -- and, for
    // Section 203 specifically, sidesteps its #VALUE! cells entirely: the
    // corruption there is a blank Sq. Ft. cell breaking THAT workbook's
    // OWN formula, never the raw Qty/Unit Cost/Sq. Ft. inputs this parser
    // actually reads.
    const rawUnitCost = numericOrNull(row.getCell(header.unitCostCol).value) ?? 0;
    const unitCost = sqFtRaw && sqFtRaw > 0 ? rawUnitCost * sqFtRaw : rawUnitCost;

    rows.push({
      rowNumber,
      category: currentCategory,
      description,
      sourceQuote: rawDescription || type || "",
      qty,
      unitCost,
      catalogMatch: matchDescription(description, catalog),
    });
  }

  return {
    kind: "design-cost-estimate",
    documentId,
    filename: document.filename,
    sheetName: sheet.name,
    buildName,
    boothLabel,
    rows,
    categories: [...new Set(rows.map((r) => r.category))],
  };
}

// Same commit shape as pricing-import-service.ts's commitPricingImport:
// one EstimateSection per (boothLabel, category) pair via findOrCreateSection
// (reuse-safe across repeated imports into the same version), bulk-created
// isDraft LineItems carrying documentId/sourceQuote back-references, same
// "already imported" idempotency guard. A row with unitCost still 0 is
// imported anyway, not skipped -- the workbook's own disclaimer text says
// outright "All items may not have a cost associated. You will need to
// manually enter a cost," so a $0 draft row is the honest, reviewable
// result, matching how every other "needs pricing" gap already surfaces
// elsewhere in this app.
export async function commitDesignCostEstimateImport(estimateVersionId: string, documentId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });
  const preview = await previewDesignCostEstimateImport(documentId, version.estimate.opportunityId);
  if (preview.rows.length === 0) {
    throw new Error(`No line items found in "${preview.filename}".`);
  }

  const alreadyImported = await db.lineItem.findFirst({
    where: { documentId, section: { estimateVersionId, optionId: null } },
  });
  if (alreadyImported) {
    throw new Error(
      `"${preview.filename}" has already been imported into this estimate. Delete its existing line items first if you want to re-import.`,
    );
  }

  // Persists the Build Name onto the Document row itself so the mirror
  // check in page.tsx can compare it against sibling documents without
  // re-parsing every workbook on every render.
  if (preview.buildName) {
    await db.document.update({ where: { id: documentId }, data: { buildName: preview.buildName } });
  }

  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });
  const categories = await db.category.findMany({ where: { deletedAt: null } });

  const groupKey = (row: ParsedDesignCostRow) => `${preview.boothLabel ?? ""} ${row.category}`;
  const seenKeys = new Set<string>();
  const groups: { category: string }[] = [];
  for (const row of preview.rows) {
    const key = groupKey(row);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    groups.push({ category: row.category });
  }

  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const group of groups) {
    const section = await findOrCreateSection(estimateVersionId, {
      name: group.category,
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
      groupLabel: preview.boothLabel,
    });

    const rowsForGroup = preview.rows.filter((r) => groupKey(r) === `${preview.boothLabel ?? ""} ${group.category}`);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      rowsForGroup.map((row) => ({
        lineType: "MATERIAL" as const,
        description: row.description,
        qty: row.qty,
        // Unlike pricing-import-service.ts's schedules (which never carry
        // a cost at all -- that's the bidder's job), this workbook already
        // has the estimator's own real Unit Cost per row, including
        // legitimate $0 "not yet priced" placeholders -- that's always the
        // source of truth here, never overridden by a guessed catalog
        // match (catalogMatch is still surfaced in the preview purely as
        // a review hint).
        unitCost: row.unitCost,
        // The workbook's own banner-row category ("Wall Panels",
        // "BeMatrix", "Labor:", ...) is a more reliable signal here than
        // a catalog match or a description guess -- these part
        // descriptions ("310mm x 2418mm Frame") never contain a
        // category-identifying word themselves. See
        // mapDesignCostCategoryToCanonical's own comment for why this
        // isn't routed through resolveLineItemCategory's generic chain.
        //
        // SEG is the one exception, checked before the banner mapping --
        // confirmed live as a real miscategorization: a vendor's own
        // "Wall Panels" banner group routinely mixes structural wall-panel
        // frames with SEG fabric graphic panels, and the banner mapping
        // alone would send both to Structure. SEG fabric is always
        // Graphics regardless of which banner group it happens to sit
        // under (see isAlwaysGraphicsDescription's own comment).
        category:
          (isAlwaysGraphicsDescription(row.description) ? resolveCategoryNameFromKey(categories, "graphics") : null) ??
          mapDesignCostCategoryToCanonical(row.category, categories) ??
          mapCatalogCategoryToCanonical(row.catalogMatch?.category, categories) ??
          inferCategoryFromDescription(row.description, categories),
        isClientOwned: inferIsClientOwned(row.description),
        documentId,
        sourceQuote: row.sourceQuote,
      })),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: preview.rows.length };
}
