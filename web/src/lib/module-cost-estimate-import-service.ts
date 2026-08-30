// Deterministic parser for the "per-module Sheet Goods / Other Items /
// Labor" workbook shape -- confirmed live against two real files from two
// different real jobs (Full Swing Chicago's ABCA_2027_Exhibit_Cost_
// Breakout.xlsx, 8 real element sheets; Full Swing Orlando's own
// fabrication estimate, 32 real module sheets) that this app's AI-fallback
// spreadsheet importer (spreadsheet-line-item-service.ts) was silently
// collapsing into one lump-sum "package" line item per module instead of
// itemizing the real, individually-priced Sheet Goods/Other Items/Labor
// rows each module's own sheet actually has -- both real files' dollar
// totals matched the AI's own lump-sum proposals to the penny, so nothing
// was truly missing, but the granularity a reviewer needs (individual
// materials, individual labor lines) never made it into the estimate.
//
// Each matching sheet is ONE module/element, holding three banner-
// delimited sub-tables in sequence: "Sheet Goods", "Other Items", "Labor"
// -- each with its own header row, real per-row Qty/Unit Cost, and (on
// most but not all real sheets) its own "<X> Subtotal" closing row. A
// trailing "Estimate Totals" recap block re-lists the same three banner
// words as a compact cost summary at the bottom of every real sheet --
// confirmed live this MUST be treated as a hard stop, not just another
// banner: a module with no explicit "Labor Subtotal" row before it (Full
// Swing Orlando's own shape lacks these subtotal rows entirely) leaves
// the parser's column map still pointed at the real Labor header when it
// reaches "Estimate Totals", which otherwise gets misread as one bogus
// "Estimate Totals — Cost" line item at $0. Caught by running this
// exact parser against both real files before writing any test around it.

import ExcelJS from "exceljs";
import { db } from "@/lib/db";
import type { Category } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { addLineItemsBulk, findOrCreateSection } from "@/lib/estimate-service";
import { cellText } from "@/lib/xlsx-utils";
import {
  CUSTOM_BUILD_CATEGORY_KEY,
  inferCategoryFromDescription,
  resolveCategoryNameFromKey,
} from "@/lib/line-item-category";

type SubTable = "sheet-goods" | "other-items" | "labor";

export interface ParsedModuleCostRow {
  rowNumber: number;
  sheetName: string;
  subTable: SubTable;
  description: string;
  sourceQuote: string;
  qty: number;
  unitCost: number;
  category: string | null;
}

export interface ModuleCostEstimatePreview {
  kind: "module-cost-estimate";
  documentId: string;
  filename: string;
  rows: ParsedModuleCostRow[];
  categories: string[];
}

// A row counts as a banner only by its OWN column-1 text -- mirrors
// design-cost-estimate-import-service.ts's isBannerRow reasoning (banner
// rows are merged cells spanning the row; column 1 alone is reliable).
// Deliberately exact-match, not substring -- both real files' own
// Estimate Summary/Estimate Module rollup sheet has "Sheet Goods" /
// "Other Items" / "Labor" as column HEADERS starting in column 2+, never
// column 1, so this rule never misfires on that sheet.
function bannerKind(text: string): SubTable | null {
  if (text === "sheet goods") return "sheet-goods";
  if (text === "other items") return "other-items";
  if (text === "labor") return "labor";
  return null;
}

export function detectModuleCostEstimateSheet(sheet: ExcelJS.Worksheet): boolean {
  let sheetGoodsRow: number | null = null;
  let otherItemsRow: number | null = null;
  let laborRow: number | null = null;
  for (let r = 1; r <= sheet.rowCount; r++) {
    const text = cellText(sheet.getRow(r).getCell(1).value).trim().toLowerCase();
    const kind = bannerKind(text);
    if (kind === "sheet-goods" && sheetGoodsRow === null) sheetGoodsRow = r;
    else if (kind === "other-items" && otherItemsRow === null) otherItemsRow = r;
    else if (kind === "labor" && laborRow === null) laborRow = r;
  }
  return (
    sheetGoodsRow !== null &&
    otherItemsRow !== null &&
    laborRow !== null &&
    sheetGoodsRow < otherItemsRow &&
    otherItemsRow < laborRow
  );
}

// Scans EVERY sheet, not just the first match -- unlike
// findDesignCostEstimateSheet/findPricingSheet (pricing-import-service.ts
// / design-cost-estimate-import-service.ts), which each return only the
// first matching sheet in a workbook. Neither real file behind THIS
// importer has ever bundled its module sheets any other way than one-
// module-per-sheet-in-one-workbook, which is exactly the shape those two
// existing detectors have never had to handle -- this one does, from the
// start.
export function findModuleCostEstimateSheets(workbook: ExcelJS.Workbook): ExcelJS.Worksheet[] {
  return workbook.worksheets.filter(detectModuleCostEstimateSheet);
}

interface SubTableColumns {
  // "primary" is the row's own short label (Sheet Goods' "Material"/
  // "Item", Other Items' "Item", Labor's "Labor Type"); "qualifier" is a
  // SEPARATE, longer free-text column real files sometimes carry
  // alongside it. Confirmed live: Chicago's Other Items header splits
  // "Item" ("PURCHASE SQ FT (basic)") and "Description" ("ceiling"/"side
  // walls"/"back half wall") into two distinct columns -- three
  // otherwise-identical beMatrix rows are only distinguishable by their
  // own qualifier text, exactly the "Item column holds the real
  // distinguishing name" case pricing-import-service.ts's own
  // ParsedPricingRow already established a combine convention for.
  primaryCol: number | null;
  qualifierCol: number | null;
  categoryCol: number | null;
  qtyCol: number | null;
  unitCostCol: number | null;
  totalCostCol: number | null;
}

// Column wording differs between the two real files ("Cost / Sheet" vs
// "Unit Cost", "Qty" vs "Quantity") even though the banner words
// themselves are identical -- same alias-tolerance posture as pricing-
// import-service.ts's own findColumnMap, just one alias list per
// sub-table instead of one shared one.
const SUBTABLE_ALIASES: Record<SubTable, { primary: string[]; qualifier?: string[]; category?: string[]; qty: string[]; unitCost: string[]; totalCost: string[] }> = {
  "sheet-goods": {
    primary: ["material", "item"],
    qty: ["qty", "quantity"],
    unitCost: ["unit cost", "cost / sheet"],
    totalCost: ["total cost", "ext cost"],
  },
  "other-items": {
    primary: ["item"],
    qualifier: ["description", "item description", "spec / notes"],
    category: ["category", "category / type"],
    qty: ["qty", "quantity"],
    unitCost: ["unit cost", "cost / item"],
    totalCost: ["total cost", "ext cost"],
  },
  labor: {
    primary: ["labor type"],
    qualifier: ["description"],
    qty: ["hours"],
    unitCost: ["hourly rate", "rate / hr"],
    totalCost: ["total cost", "labor cost"],
  },
};

function findAliasColumn(headerRow: ExcelJS.Row, aliases: string[]): number | null {
  let found: number | null = null;
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (found !== null) return;
    const text = cellText(cell.value).trim().toLowerCase();
    if (aliases.includes(text)) found = colNumber;
  });
  return found;
}

function resolveSubTableColumns(headerRow: ExcelJS.Row, subTable: SubTable): SubTableColumns {
  const aliases = SUBTABLE_ALIASES[subTable];
  return {
    primaryCol: findAliasColumn(headerRow, aliases.primary),
    qualifierCol: aliases.qualifier ? findAliasColumn(headerRow, aliases.qualifier) : null,
    categoryCol: aliases.category ? findAliasColumn(headerRow, aliases.category) : null,
    qtyCol: findAliasColumn(headerRow, aliases.qty),
    unitCostCol: findAliasColumn(headerRow, aliases.unitCost),
    totalCostCol: findAliasColumn(headerRow, aliases.totalCost),
  };
}

// A lone dash ("—", "–", "-") is this template's own explicit "nothing
// here" placeholder -- confirmed live on Full Swing Orlando's two
// genuinely-empty module sheets (Small Sim Left/Right Side lighting --
// both real, unpriced template copies never filled in), every row across
// all three sub-tables reads exactly "—" with qty/cost both 0. Same
// "blank description is a spacer row, not a line item" convention
// pricing-import-service.ts already established, just widened to also
// catch this template's own placeholder character.
function isBlankOrPlaceholder(text: string): boolean {
  return !text || /^[-—–]+$/.test(text.trim());
}

function numericOrNaN(value: unknown): number {
  if (typeof value === "number") return value;
  const text = cellText(value);
  return text ? Number(text) : Number.NaN;
}

function parseModuleSheet(sheet: ExcelJS.Worksheet): ParsedModuleCostRow[] {
  const rows: ParsedModuleCostRow[] = [];
  let state: SubTable | null = null;
  let columns: SubTableColumns | null = null;

  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const c1 = cellText(row.getCell(1).value).trim().toLowerCase();

    // The trailing "Estimate Totals" recap re-lists the same three banner
    // words as a compact summary, with no real column headers of its own
    // -- a hard stop, not just another banner switch. See this file's own
    // header comment for the exact bogus-row bug this prevents.
    if (c1 === "estimate totals") break;

    const kind = bannerKind(c1);
    if (kind) {
      state = kind;
      columns = null;
      continue;
    }
    if (!state) continue;
    if (c1.includes("subtotal")) {
      state = null;
      columns = null;
      continue;
    }
    if (!columns) {
      columns = resolveSubTableColumns(row, state);
      continue;
    }

    const primary = columns.primaryCol ? cellText(row.getCell(columns.primaryCol).value) : "";
    const qualifier = columns.qualifierCol ? cellText(row.getCell(columns.qualifierCol).value) : "";
    // Same item+description combine convention pricing-import-service.ts's
    // own ParsedPricingRow already established -- a row's real,
    // distinguishing text often lives in BOTH its short label cell
    // ("PURCHASE SQ FT (basic)", "30% Shop") and a separate qualifier cell
    // ("ceiling", "frame fab"), never just one; three otherwise-identical
    // beMatrix rows in the real Chicago file are only tellable apart this
    // way.
    const description =
      primary && qualifier && primary !== qualifier ? `${primary} — ${qualifier}` : primary || qualifier;
    if (isBlankOrPlaceholder(description)) continue;

    const qty = columns.qtyCol ? numericOrNaN(row.getCell(columns.qtyCol).value) : Number.NaN;
    if (Number.isNaN(qty)) continue;

    let unitCost = columns.unitCostCol ? numericOrNaN(row.getCell(columns.unitCostCol).value) : Number.NaN;
    if (Number.isNaN(unitCost) && columns.totalCostCol) {
      const totalCost = numericOrNaN(row.getCell(columns.totalCostCol).value);
      unitCost = !Number.isNaN(totalCost) && qty > 0 ? totalCost / qty : Number.NaN;
    }
    if (Number.isNaN(unitCost)) unitCost = 0;

    rows.push({
      rowNumber: r,
      sheetName: sheet.name,
      subTable: state,
      description,
      sourceQuote: primary || qualifier || description,
      qty,
      unitCost,
      category: columns.categoryCol ? cellText(row.getCell(columns.categoryCol).value) || null : null,
    });
  }

  return rows;
}

// Values actually observed in the "Category"/"Category / Type" column of
// real Other Items rows across both real files -- deliberately NOT
// exhaustive (Orlando's own file mostly just says the generic "Other
// Item" for this column, which is intentionally left unmapped here so it
// falls through to inferCategoryFromDescription instead of a guessed
// label). "sheet goods" rows never go through this map at all -- see
// resolveOtherItemCategory's own caller.
const OTHER_ITEM_CATEGORY_KEY_MAP: Record<string, string> = {
  "bematrix": "structure",
  "graphics": "graphics",
  "lighting and electrical": CUSTOM_BUILD_CATEGORY_KEY,
  "hardware": "accessories",
  "shop supplies": CUSTOM_BUILD_CATEGORY_KEY,
  "other custom cost": CUSTOM_BUILD_CATEGORY_KEY,
  "crates": "shipping",
  "extrusions": CUSTOM_BUILD_CATEGORY_KEY,
  "shipping costs": "shipping",
  "weld": CUSTOM_BUILD_CATEGORY_KEY,
};

// Per-sub-table category resolution -- deliberately different logic per
// sub-table, not one shared heuristic:
// - labor rows: always "labor", the banner itself is the signal.
// - sheet-goods rows: always Custom Build -- raw fabrication-input
//   materials, same established rationale line-item-category.ts's own
//   CATALOG_CATEGORY_KEY_MAP already applies to "Wood & Sheet Goods" etc.
// - other-items rows: the row's own Category cell first, falling back to
//   inferCategoryFromDescription on its item text, falling back to
//   Custom Build as the same "fabrication input, no better signal"
//   default sheet-goods rows already get.
function resolveModuleRowCategory(
  row: ParsedModuleCostRow,
  categories: Pick<Category, "key" | "name">[],
): string | null {
  if (row.subTable === "labor") return resolveCategoryNameFromKey(categories, "labor");
  if (row.subTable === "sheet-goods") return resolveCategoryNameFromKey(categories, CUSTOM_BUILD_CATEGORY_KEY);

  const key = row.category ? OTHER_ITEM_CATEGORY_KEY_MAP[row.category.trim().toLowerCase()] : undefined;
  if (key) {
    const resolved = resolveCategoryNameFromKey(categories, key);
    if (resolved) return resolved;
  }
  return (
    inferCategoryFromDescription(row.description, categories) ??
    resolveCategoryNameFromKey(categories, CUSTOM_BUILD_CATEGORY_KEY)
  );
}

// opportunityId is the caller's already-access-checked opportunity, NOT
// trusted from documentId alone -- see every other importer's own
// header comment (pricing-import-service.ts, design-cost-estimate-
// import-service.ts) for the identical cross-resource-id rationale.
export async function previewModuleCostEstimateImport(
  documentId: string,
  opportunityId: string,
): Promise<ModuleCostEstimatePreview> {
  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const sheets = findModuleCostEstimateSheets(workbook);
  if (sheets.length === 0) {
    throw new Error(`"${document.filename}" doesn't look like a per-module Sheet Goods/Other Items/Labor workbook.`);
  }

  const rows = sheets.flatMap((sheet) => parseModuleSheet(sheet));

  return {
    kind: "module-cost-estimate",
    documentId,
    filename: document.filename,
    rows,
    categories: [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))],
  };
}

// Same idempotency-guard/findOrCreateSection/addLineItemsBulk shape every
// other importer in this app uses. One EstimateSection per (module sheet,
// resolved category) pair, groupLabel: sheet.name -- same shape as every
// other importer's own (booth/sheet, category) grouping, so this shape's
// line items land in real per-module sections automatically. Fully
// deterministic -- isDraft still defaults true via addLineItemsBulk's own
// default (still needs a human review pass before it counts toward the
// estimate total), but no "AI-proposed, verify" caveat is needed in the
// UI the way spreadsheet-line-item-service.ts's own commit requires.
export async function commitModuleCostEstimateImport(estimateVersionId: string, documentId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: { estimate: { select: { opportunityId: true } } },
  });
  const preview = await previewModuleCostEstimateImport(documentId, version.estimate.opportunityId);
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

  const liveCategories = await db.category.findMany({ where: { deletedAt: null } });
  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });

  const rowsWithCategory = preview.rows.map((row) => ({
    row,
    category: resolveModuleRowCategory(row, liveCategories),
  }));

  const groupKey = (sheetName: string, category: string | null) => `${sheetName} ${category ?? ""}`;
  const seenKeys = new Set<string>();
  const groups: { sheetName: string; category: string | null }[] = [];
  for (const { row, category } of rowsWithCategory) {
    const key = groupKey(row.sheetName, category);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    groups.push({ sheetName: row.sheetName, category });
  }

  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const group of groups) {
    const section = await findOrCreateSection(estimateVersionId, {
      name: group.category ?? "Other",
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
      groupLabel: group.sheetName,
    });

    const rowsForGroup = rowsWithCategory.filter(
      ({ row, category }) => groupKey(row.sheetName, category) === groupKey(group.sheetName, group.category),
    );
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      rowsForGroup.map(({ row }) => ({
        lineType: (row.subTable === "labor" ? "LABOR" : "MATERIAL") as "LABOR" | "MATERIAL",
        description: row.description,
        qty: row.qty,
        unitCost: row.unitCost,
        category: group.category,
        documentId,
        sourceQuote: row.sourceQuote,
      })),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: preview.rows.length };
}
