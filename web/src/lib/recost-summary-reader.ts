// Reads the element summary out of a cost-breakout workbook.
//
// Distinct from pricing-import-service.ts, which parses the DETAIL sheets
// into line items. This reads the Summary tab -- one row per element,
// with the total and, on a revised workbook, the estimator's own status
// against it. That status column is the primary source for a re-cost
// (see recost-status.ts), and nothing else in this app was reading it.
//
// Deliberately forgiving about layout and strict about what it will
// claim. A summary it cannot confidently identify returns null rather
// than a half-parsed one, because a wrong pairing here produces
// confident nonsense about money.

import ExcelJS from "exceljs";
import type { SummaryRow } from "@/lib/recost-status";

// The header cells that identify a real summary sheet. "Element" and a
// total column together are specific enough not to false-positive on a
// detail tab, which has Material/Thickness/Width headers instead.
const ELEMENT_HEADER = /^element$/i;
const TOTAL_HEADER = /project\s*total/i;
const CLIENT_HEADER = /^client$/i;

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("");
    }
    if ("result" in value) return String((value as { result: unknown }).result ?? "");
    if ("text" in value) return String((value as { text: unknown }).text ?? "");
    return "";
  }
  return String(value);
}

function cellNumber(value: ExcelJS.CellValue): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object" && "result" in value) {
    const r = (value as { result: unknown }).result;
    if (typeof r === "number" && Number.isFinite(r)) return r;
  }
  const n = Number(cellText(value).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

interface SummaryLayout {
  sheet: ExcelJS.Worksheet;
  headerRow: number;
  clientCol: number | null;
  elementCol: number;
  totalCol: number;
  // Where the status is written. It has no header, and on the real file
  // it is not adjacent to the total either -- Full Swing's workbook has
  // an empty spacer at column 8 and the status at column 9. So this is a
  // range to scan rather than a fixed offset.
  statusFrom: number;
  statusTo: number;
}

function findSummary(workbook: ExcelJS.Workbook): SummaryLayout | null {
  for (const sheet of workbook.worksheets) {
    const limit = Math.min(12, sheet.rowCount);
    for (let r = 1; r <= limit; r++) {
      const row = sheet.getRow(r);
      let elementCol: number | null = null;
      let totalCol: number | null = null;
      let clientCol: number | null = null;

      row.eachCell({ includeEmpty: false }, (cell, col) => {
        const text = cellText(cell.value).trim();
        if (ELEMENT_HEADER.test(text)) elementCol = col;
        else if (TOTAL_HEADER.test(text)) totalCol = col;
        else if (CLIENT_HEADER.test(text)) clientCol = col;
      });

      if (elementCol !== null && totalCol !== null) {
        return {
          sheet,
          headerRow: r,
          clientCol,
          elementCol,
          totalCol,
          statusFrom: totalCol + 1,
          // Four columns is enough for a spacer or two and generous
          // enough not to need revisiting, while staying near the total
          // rather than sweeping the whole row.
          statusTo: totalCol + 4,
        };
      }
    }
  }
  return null;
}

export interface SummaryReadResult {
  sheetName: string;
  rows: SummaryRow[];
  // True when any row carried a status. A revised workbook has them; the
  // original it replaces does not, and that asymmetry is expected rather
  // than a problem -- the statuses describe the change, so they only
  // exist on the later file.
  hasStatuses: boolean;
}

export function readSummaryFromWorkbook(workbook: ExcelJS.Workbook): SummaryReadResult | null {
  const layout = findSummary(workbook);
  if (!layout) return null;

  const rows: SummaryRow[] = [];
  for (let r = layout.headerRow + 1; r <= layout.sheet.rowCount; r++) {
    const row = layout.sheet.getRow(r);
    const element = cellText(row.getCell(layout.elementCol).value).trim();
    if (!element) continue;
    // The totals row is not an element. Matched on the element cell
    // rather than the client cell because the client column is optional.
    if (/^grand\s*total$/i.test(element) || /subtotal$/i.test(element)) continue;

    const total = cellNumber(row.getCell(layout.totalCol).value);
    if (total === null) continue;

    // First non-empty, non-numeric cell to the right of the total. Empty
    // spacer columns are skipped; a stray number is not mistaken for a
    // note.
    let status = "";
    for (let c = layout.statusFrom; c <= layout.statusTo; c++) {
      const text = cellText(row.getCell(c).value).trim();
      if (!text) continue;
      if (cellNumber(row.getCell(c).value) !== null) continue;
      status = text;
      break;
    }
    rows.push({
      client: layout.clientCol ? cellText(row.getCell(layout.clientCol).value).trim() : "",
      element,
      total,
      status: status || null,
    });
  }

  if (rows.length === 0) return null;
  return {
    sheetName: layout.sheet.name,
    rows,
    hasStatuses: rows.some((r) => r.status !== null),
  };
}

export async function readSummaryFromBytes(bytes: Buffer): Promise<SummaryReadResult | null> {
  const workbook = new ExcelJS.Workbook();
  // exceljs's own Buffer type comes from a different @types/node
  // generation than this project's -- structurally identical at runtime,
  // same cast pricing-import-service.ts already makes.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  return readSummaryFromWorkbook(workbook);
}
