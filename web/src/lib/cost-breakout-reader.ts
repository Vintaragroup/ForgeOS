// Reads an in-house cost breakout workbook down to its individual rows.
//
// Distinct from recost-summary-reader.ts, which reads the Summary tab --
// one row per element, eight rows for the whole job. That is the right
// resolution for "did this element move", and the wrong one for "what
// changed", which is the question an estimator actually has to answer.
// The detail tabs carry 240 rows and the two workbooks agree row for row,
// so this is where the precision is.
//
// Each element tab holds THREE blocks, and they do not share a column
// layout. Getting this wrong is why a first pass joined only 99 of 192
// line items -- it indexed column B, which is only the identity column
// for one of the three:
//
//   SHEET GOODS   Material | Thickness | Width | Length | Unit Cost | Units | Quantity
//                 identity is column A, and it repeats: "China Birch"
//                 appears twice at two thicknesses and two prices.
//
//   OTHER ITEMS   Category | Item | Description | Unit Cost | Units | Quantity | Total Cost
//                 identity is column B.
//
//   LABOR         Labor Type | Description | Hourly Rate | Hours | Total Cost
//                 identity is A and B together -- "30% Shop" alone names
//                 four different rows on one tab.
//
// The description each row produces is composed exactly the way the
// import composed it, because that string is the join back to the
// LineItem the row created.
//
// A leaf module: pure functions over a workbook, no db import.

import type ExcelJS from "exceljs";
import { cellText } from "@/lib/xlsx-utils";

export type CostBreakoutBlock = "SHEET_GOODS" | "OTHER_ITEMS" | "LABOR";

export interface CostBreakoutRow {
  tab: string;
  block: CostBreakoutBlock;
  rowNumber: number;
  // What the import made this row's LineItem.description. The join key.
  description: string;
  // Distinguishes two rows that share a description -- sheet goods carry
  // a thickness, and "China Birch 3/4" and "China Birch 1/4" are
  // different materials at different prices wearing one name.
  variant: string | null;
  qty: number | null;
  unitCost: number | null;
  unit: string | null;
}

export interface CostBreakoutSheet {
  tab: string;
  // Row 1, which names the element -- and carries spec changes nothing
  // else records. "Diamond Sign Logo 3'10"" became "NON LIT Diamond Sign
  // Logo 3'10"" between versions, and the only other trace of the signs
  // losing their lighting is the LED rows going to zero underneath.
  title: string;
  rows: CostBreakoutRow[];
}

// Matched on the FIRST TWO cells, not the first. A "Data Notes" tab
// carrying the word "Category" in column A was otherwise read as an
// element with five rows of work in it, and then reported as an entire
// element deleted when the revised workbook dropped the notes tab.
const BLOCK_HEADERS: [CostBreakoutBlock, RegExp, RegExp][] = [
  ["SHEET_GOODS", /^material$/i, /^thickness$/i],
  ["OTHER_ITEMS", /^category$/i, /^item$/i],
  ["LABOR", /^labor\s*type$/i, /^description$/i],
];
const SKIP_ROW = /subtotal|project\s*total/i;

// Column positions per block, 1-indexed, from the header signatures
// above. Confirmed identical across both of Full Swing's workbooks and
// every one of their element tabs.
const LAYOUT: Record<CostBreakoutBlock, { unitCost: number; qty: number; unit: number | null }> = {
  SHEET_GOODS: { unitCost: 5, qty: 7, unit: 6 },
  OTHER_ITEMS: { unitCost: 4, qty: 6, unit: 5 },
  // Hourly rate and hours. An hour is a quantity and a rate is a unit
  // cost, so labour needs no special case downstream.
  LABOR: { unitCost: 3, qty: 4, unit: null },
};

function num(value: ExcelJS.CellValue): number | null {
  const raw = cellText(value).replace(/[$,]/g, "").trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

// A banner ("SHEET GOODS") and the element title both repeat the same
// text across every column. Neither is a row of work.
function isRepeatedAcross(row: ExcelJS.Row, columns = 5): boolean {
  const first = cellText(row.getCell(1).value).trim();
  if (!first) return false;
  for (let c = 2; c <= columns; c++) {
    if (cellText(row.getCell(c).value).trim() !== first) return false;
  }
  return true;
}

// Both OTHER ITEMS and LABOR carry a second, qualifying cell that the
// import folds into the description with an em dash when it is filled --
// "SEG BACKLIT — 8.5ft x 21 - 179", "30% Shop — build and lam". Where it
// is empty the identity cell stands alone. Reproducing that exactly is
// the whole join: it took the match from 99 of 192 to all of them.
function describe(block: CostBreakoutBlock, a: string, b: string, c: string): string {
  if (block === "SHEET_GOODS") return a;
  const [identity, qualifier] = block === "OTHER_ITEMS" ? [b, c] : [a, b];
  return qualifier ? `${identity} — ${qualifier}` : identity;
}

export function readCostBreakoutSheet(sheet: ExcelJS.Worksheet): CostBreakoutSheet | null {
  const title = cellText(sheet.getRow(1).getCell(1).value).trim();
  const rows: CostBreakoutRow[] = [];
  let block: CostBreakoutBlock | null = null;

  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const a = cellText(row.getCell(1).value).trim();
    const b = cellText(row.getCell(2).value).trim();

    const header = BLOCK_HEADERS.find(([, first, second]) => first.test(a) && second.test(b));
    if (header) { block = header[0]; continue; }

    if (!block) continue;
    // A subtotal closes its block; the next header opens the next one.
    if (SKIP_ROW.test(a)) { block = null; continue; }
    if (isRepeatedAcross(row)) continue;

    const description = describe(block, a, b, cellText(row.getCell(3).value).trim());
    if (!description) continue;

    const layout = LAYOUT[block];
    rows.push({
      tab: sheet.name,
      block,
      rowNumber: r,
      description,
      // Thickness, which is the only thing telling two China Birch rows
      // apart. Null everywhere else: nothing there needs it.
      variant: block === "SHEET_GOODS" ? cellText(row.getCell(2).value).trim() || null : null,
      qty: num(row.getCell(layout.qty).value),
      unitCost: num(row.getCell(layout.unitCost).value),
      unit: layout.unit ? cellText(row.getCell(layout.unit).value).trim() || null : null,
    });
  }

  if (rows.length === 0) return null;
  return { tab: sheet.name, title, rows };
}

// Every element tab in the workbook. Summary and Data Notes are not
// element tabs and are skipped by shape rather than by name -- a workbook
// with neither, or with either renamed, still reads correctly.
export function readCostBreakout(workbook: ExcelJS.Workbook): CostBreakoutSheet[] {
  const sheets: CostBreakoutSheet[] = [];
  for (const sheet of workbook.worksheets) {
    const parsed = readCostBreakoutSheet(sheet);
    if (parsed) sheets.push(parsed);
  }
  return sheets;
}
