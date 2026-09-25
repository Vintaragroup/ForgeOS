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
import { loadDuplicateCandidates } from "@/lib/ai/scope-line-item-service";
import { findExactDuplicates, type ProposedItemForDuplicateCheck } from "@/lib/ai/line-item-duplicate-service";

type SubTable = "sheet-goods" | "other-items" | "labor";

export interface ParsedModuleCostRow {
  rowNumber: number;
  sheetName: string;
  // The banner this row sits under, verbatim. Carried because it is often
  // the strongest category signal on the row: "PURCHASED ITEMS" says
  // nothing, but "EXISTING / CLIENT-OWNED PROPERTY" and "RENTAL BOOTH I&D
  // CONSUMABLES" say a great deal, and the row's own description
  // ("LOOSE REAL-WOOD / WOOD-GRAIN FURNITURE") does not always.
  bannerText: string;
  subTable: SubTable;
  description: string;
  sourceQuote: string;
  qty: number;
  unitCost: number;
  // The row's own Category CELL, when its sheet has one. Most dialects do
  // not: Club Glove's blocks are ITEM/UNIT/QTY/COST, no Category column
  // at all, so this is null for every one of its 72 rows.
  category: string | null;
  // The category this row will actually be filed under, by the rules in
  // resolveModuleRowCategory. Resolved during PREVIEW so the screen shows
  // what committing would really do -- it used to be computed only at
  // commit, and the preview displayed the raw cell above, so a workbook
  // with no Category column showed 72 rows of "—" and looked like the
  // importer had given up on all of them.
  resolvedCategory: string | null;
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

// A recap/rollup row that ends the itemized part of a sheet. "Estimate
// Totals" is the shape the first two real files use; "Category Totals" is
// what a third writes. Either way the rows after it are a cost summary,
// not work -- see this file's header comment for the bogus $0 line item
// this prevents.
function isRecapBanner(text: string): boolean {
  return text === "estimate totals" || text === "category totals";
}

// Whether a row is a banner AT ALL: its own column-1 text, and nothing
// beside it. Both real dialects write banners as a merged cell spanning
// the row, so anything with a second populated cell is a data or header
// row, never a banner. This is also what keeps the Estimate Summary
// rollup sheet out -- its "Sheet Goods"/"Other Items"/"Labor" are column
// HEADERS sitting in columns 3-6 of a populated row.
function isBannerRow(row: ExcelJS.Row): boolean {
  const first = cellText(row.getCell(1).value).trim();
  if (!first) return false;
  // A merged cell spanning the row does not always read back as "column 1
  // populated, rest empty" -- both proven real files serialize it as the
  // SAME text repeated in every cell it spans. Requiring the rest to be
  // empty rejected both of them outright, which their own tests caught.
  let othersDiffer = false;
  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    if (colNumber === 1) return;
    const text = cellText(cell.value).trim();
    if (text && text !== first) othersDiffer = true;
  });
  return !othersDiffer;
}

// What KIND of block a banner opens, read from the header row underneath
// it rather than from the banner's own words.
//
// The three fixed words above were every banner the first two real files
// used. A third real file -- Club Glove's PGA 2027 estimate -- writes the
// same three-block-per-module shape with "SHOP SUPPLIES", "PURCHASED
// ITEMS", "RENTAL BOOTH I&D CONSUMABLES" and "EXISTING / CLIENT-OWNED
// PROPERTY" where the others write "OTHER ITEMS". Every one of those is a
// materials block with identical columns, and the old detector rejected
// the entire 10-sheet workbook over the wording, so $46,076 of priced,
// itemized work fell through to the AI scope fallback and came back as 7
// guesses at qty 1 with no costs.
//
// Chasing that vocabulary with a longer list of literals only works until
// the next estimator names a block something else. What actually decides
// how a block parses is its header row, so that is what classifies it: a
// header carrying HOURS is labor, anything else with a quantity and a
// cost is materials.
const HEADER_QTY_ALIASES = ["qty", "quantity", "hours", "units", "qty / area", "finished area", "size / qty"];
const HEADER_COST_ALIASES = [
  "cost",
  "unit cost",
  "cost / item",
  "cost / sheet",
  "cost / unit",
  "cost / sf",
  "rate / hour",
  "hourly rate",
  "rate / hr",
];

function headerCells(row: ExcelJS.Row): string[] {
  const texts: string[] = [];
  row.eachCell({ includeEmpty: false }, (cell) => texts.push(cellText(cell.value).trim().toLowerCase()));
  return texts;
}

// A row that opens a priced table: enough columns to be a header, and
// both a quantity and a cost among them. Without BOTH it is a bill of
// materials, not something to import -- a real beMatrix sheet lists 86
// frames with counts and areas but no prices, because they are priced
// collectively further down.
function looksLikePricedHeader(row: ExcelJS.Row): boolean {
  const texts = headerCells(row);
  if (texts.length < 3) return false;
  return texts.some((t) => HEADER_QTY_ALIASES.includes(t)) && texts.some((t) => HEADER_COST_ALIASES.includes(t));
}

function classifyBannerByHeader(sheet: ExcelJS.Worksheet, bannerRowNumber: number): SubTable | null {
  for (let r = bannerRowNumber + 1; r <= Math.min(bannerRowNumber + 3, sheet.rowCount); r++) {
    const row = sheet.getRow(r);
    if (!looksLikePricedHeader(row)) continue;
    return headerCells(row).includes("hours") ? "labor" : "other-items";
  }
  return null;
}

export function detectModuleCostEstimateSheet(sheet: ExcelJS.Worksheet): boolean {
  // Was: sheet goods AND other items AND labor, in that order, by those
  // exact words. That rejected a real workbook whose modules run sheet
  // goods -> shop supplies -> labor, and also rejects any module that
  // legitimately has no labor (a pure logistics/consumables sheet) or no
  // materials (a pure labor sheet). Both exist in the same real file.
  //
  // What actually makes a sheet parseable is having priced blocks on it,
  // so that is the test: two recognized blocks, or one plus the module
  // rollup that only a real module sheet carries.
  let blocks = 0;
  let hasModuleRollup = false;
  let pastRecap = false;
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const c1 = cellText(row.getCell(1).value).trim().toLowerCase();
    // The rollup is evidence, and on a real one-block logistics module it
    // sits AFTER the recap -- so the scan reads to the end of the sheet
    // and only stops COUNTING blocks at the recap. Breaking outright here
    // lost the single strongest signal the sheet had.
    if (c1.startsWith("module total") || c1.startsWith("project total") || isRecapBanner(c1)) {
      hasModuleRollup = true;
      if (isRecapBanner(c1)) pastRecap = true;
      continue;
    }
    if (pastRecap || !isBannerRow(row)) continue;
    if (bannerKind(c1) ?? classifyBannerByHeader(sheet, r)) blocks += 1;
  }
  return blocks >= 2 || (blocks >= 1 && hasModuleRollup);
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
    unitCost: ["unit cost", "cost / sheet", "cost / item"],
    totalCost: ["total cost", "ext cost"],
  },
  "other-items": {
    primary: ["item"],
    // "basis / notes" is the only descriptive column a SEG block has --
    // its own rows are bare labels ("D1", "B2"), meaningless alone.
    qualifier: ["description", "item description", "spec / notes", "basis / notes"],
    category: ["category", "category / type"],
    qty: ["qty", "quantity", "qty / area", "finished area", "size / qty"],
    unitCost: ["unit cost", "cost / item", "cost / unit", "cost / sf", "cost"],
    totalCost: ["total cost", "ext cost"],
  },
  labor: {
    // "type" is Club Glove's own header for the same column the other two
    // files call "labor type".
    primary: ["labor type", "type"],
    qualifier: ["description"],
    qty: ["hours"],
    unitCost: ["hourly rate", "rate / hr", "rate / hour"],
    totalCost: ["total cost", "labor cost", "ext cost"],
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

// Exported for tests only -- the dialect assertions need to read rows
// straight out of a constructed sheet, without a document/upload round
// trip.
export const parseModuleSheetForTest = (sheet: ExcelJS.Worksheet) => parseModuleSheet(sheet);

function parseModuleSheet(sheet: ExcelJS.Worksheet): ParsedModuleCostRow[] {
  const rows: ParsedModuleCostRow[] = [];
  let state: SubTable | null = null;
  let columns: SubTableColumns | null = null;
  let bannerLabel = "";

  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const c1 = cellText(row.getCell(1).value).trim().toLowerCase();

    // The trailing "Estimate Totals" recap re-lists the same three banner
    // words as a compact summary, with no real column headers of its own
    // -- a hard stop, not just another banner switch. See this file's own
    // header comment for the exact bogus-row bug this prevents.
    if (isRecapBanner(c1)) break;

    if (isBannerRow(row)) {
      // A banner ALWAYS ends the block above it, even when this parser
      // cannot classify the one it opens. Continuing with the previous
      // table's column map is how "STANDARD + ADDED FRAME RENTAL" got
      // read with the slatwall table's columns -- qty from one table,
      // "unit cost" landing on the next table's EXT COST -- and produced
      // a single $10,555,888 line item on a $20,677 module. Failing to
      // parse a block costs rows; parsing it with the wrong columns costs
      // trust in every row.
      state = bannerKind(c1) ?? classifyBannerByHeader(sheet, r);
      columns = null;
      bannerLabel = cellText(row.getCell(1).value).trim();
      continue;
    }

    // A priced table with no banner of its own. The SEG blocks on a real
    // beMatrix sheet sit directly under the frame table's total row, with
    // their own header and no banner -- $9,619 of graphics that nothing
    // would otherwise open a block for.
    if (!state && looksLikePricedHeader(row)) {
      state = "other-items";
      columns = resolveSubTableColumns(row, "other-items");
      bannerLabel = cellText(row.getCell(1).value).trim();
      continue;
    }
    if (!state) continue;
    // "Sheet Goods Subtotal" in one dialect, "SHEET GOODS TOTAL" and
    // "LEFT-HAND ENCLOSURE / STORAGE — SEG TOTAL" in another.
    if (c1.includes("subtotal") || /\btotal$/.test(c1)) {
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
      bannerText: bannerLabel,
      subTable: state,
      description,
      sourceQuote: primary || qualifier || description,
      qty,
      unitCost,
      category: columns.categoryCol ? cellText(row.getCell(columns.categoryCol).value) || null : null,
      // Filled in by the preview, which is the first place live Category
      // rows are available.
      resolvedCategory: null,
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
// One module sheet is ONE element, and an element does not get taken
// apart by trade.
//
// The estimating lead's rule, in their own words: "the system should not
// break out labor and graphics out of the elements that are being built."
// A counter's plywood, its drawer slides, its LED strip, its front logo
// and the shop hours to build it are one thing a client is quoted for,
// not five rows filed under five headings. Labor stands alone only when
// it is not building something -- show site, install, dismantle -- and
// graphics only when they are not attached to a build.
//
// Splitting by row category also went wrong in a way this makes
// impossible: "DRAWER SLIDES + HANDLES ALLOWANCE -- Two counters x $200"
// matched the furniture pattern on the word "counters" and left the
// build it belongs to. Inside an element there is now nothing to
// mis-file.
//
// A module counts as built when the shop touches it -- it has a labor
// block, or sheet goods. A pure logistics or consumables sheet has
// neither and keeps its own category.
function moduleCategory(
  rows: ParsedModuleCostRow[],
  categories: Pick<Category, "key" | "name">[],
): string | null {
  const shopWorksOnIt = rows.some((r) => r.subTable === "labor" || r.subTable === "sheet-goods");
  if (shopWorksOnIt) return resolveCategoryNameFromKey(categories, CUSTOM_BUILD_CATEGORY_KEY);
  // Nothing is built here, so the rows speak for themselves; the biggest
  // one names the module.
  let best: { category: string | null; cost: number } | null = null;
  for (const row of rows) {
    const cost = row.qty * row.unitCost;
    if (best === null || cost > best.cost) best = { category: resolveModuleRowCategory(row, categories), cost };
  }
  return best?.category ?? resolveCategoryNameFromKey(categories, CUSTOM_BUILD_CATEGORY_KEY);
}

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
  // Three signals, most specific first, before giving up and calling it
  // fabrication. Only the row's own description used to be consulted, and
  // on a real workbook with no Category column that meant nearly every
  // materials row landed on the Custom Build fallback -- a monitor kiosk,
  // a pallet of client-owned furniture and a booth's shipping consumables
  // all filed as Custom Build, which is not what any of them are.
  //
  // The banner is right there and is sometimes far more telling than the
  // row text. Order matters -- the row's own words win whenever they say
  // anything, so a shipping crate listed inside a furniture block is
  // still shipping.
  //
  // The SHEET name is deliberately NOT consulted, though it was tried: a
  // module sheet is named after the thing being built, and this workbook
  // has "01 Order Writing Counter", "02 Drawer Counter". "Counter" is a
  // furniture word, so falling back to the sheet name filed a custom-
  // fabricated counter's own building supplies as Furniture. A signal
  // that confident and that wrong is worse than the honest Custom Build
  // default.
  return (
    inferCategoryFromDescription(row.description, categories) ??
    inferCategoryFromDescription(row.bannerText, categories) ??
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

  const liveCategories = await db.category.findMany({ where: { deletedAt: null } });
  // Resolved per SHEET, not per row: every row of one module carries the
  // module's own category, so the element stays whole. See moduleCategory.
  const rows = sheets.flatMap((sheet) => {
    const sheetRows = parseModuleSheet(sheet);
    const category = moduleCategory(sheetRows, liveCategories);
    return sheetRows.map((row) => ({ ...row, resolvedCategory: category }));
  });

  return {
    kind: "module-cost-estimate",
    documentId,
    filename: document.filename,
    rows,
    categories: [...new Set(rows.map((r) => r.resolvedCategory).filter((c): c is string => !!c))],
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

  // Fresh Tier 1 (free, deterministic) exact-description match against
  // the REAL commit target's current line items -- replaces the old
  // whole-document "already imported" guard the same way
  // pricing-import-service.ts's own commitPricingImport does; see that
  // function's identical comment for the full rationale (no separate
  // "propose" step here to cache an AI call at, so this stays Tier 1
  // only). Silently excludes a detected duplicate instead of throwing.
  const duplicateCandidates = await loadDuplicateCandidates(estimateVersionId);
  // groupKey = the row's own module/element sheet -- confirmed live
  // against a real production file where 32 sheets each independently
  // call for the same generic "Mixed Hardware"/"Shop Supplies" allowance
  // (description alone only recovered 63 of 309 rows on re-import; the
  // sheet name recovers most of the rest). See findExactDuplicates's own
  // comment for the two-pass matching this feeds.
  const proposedForDuplicateCheck: ProposedItemForDuplicateCheck[] = preview.rows.map((row) => ({
    description: row.description,
    qty: row.qty,
    unit: null,
    groupKey: row.sheetName,
  }));
  const exactDuplicates = findExactDuplicates(proposedForDuplicateCheck, duplicateCandidates);
  const rows = preview.rows.filter((_, i) => !exactDuplicates.has(i));

  const existingSectionCount = await db.estimateSection.count({ where: { estimateVersionId, optionId: null } });

  // Whatever the preview showed, not a second resolution of the same
  // rules -- the screen and the commit have to agree about which section
  // a row lands in.
  const rowsWithCategory = rows.map((row) => ({ row, category: row.resolvedCategory }));

  const groupKey = (sheetName: string, category: string | null) => `${sheetName} ${category ?? ""}`;
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

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: rows.length };
}
