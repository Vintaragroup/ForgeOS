// In-app document viewing -- separate from ai/text-extraction.ts, which
// extracts PLAIN text for the AI summarizer/chat. This produces
// structured/HTML output meant for a human to actually read in the
// browser: every sheet of a spreadsheet as a real table (not just the
// pricing-schedule shape pricing-import-service.ts looks for), and a
// Word document as formatted HTML, not a wall of extracted text.

import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { cellText } from "@/lib/xlsx-utils";

export interface SpreadsheetSheet {
  name: string;
  rows: string[][];
}

const MAX_ROWS_PER_SHEET = 500; // a viewer, not an export -- generous enough for every real sheet seen so far

export async function renderSpreadsheet(bytes: Buffer): Promise<SpreadsheetSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  return workbook.worksheets.map((sheet) => {
    const rows: string[][] = [];
    const rowCount = Math.min(sheet.rowCount, MAX_ROWS_PER_SHEET);
    for (let rowNumber = 1; rowNumber <= rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber);
      const cells: string[] = [];
      for (let col = 1; col <= sheet.columnCount; col++) {
        cells.push(cellText(row.getCell(col).value));
      }
      // Skip fully-blank rows (common above/around a title block) so the
      // viewer doesn't open on a screen of empty cells.
      if (cells.some((c) => c !== "")) rows.push(cells);
    }
    return { name: sheet.name, rows };
  });
}

// mammoth's HTML output is generated from OOXML structure, not passed
// through from arbitrary text, so script/event-handler injection isn't
// realistically reachable -- still, a cheap defensive strip costs
// nothing given this renders via dangerouslySetInnerHTML.
function stripDangerousHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/\son\w+="[^"]*"/gi, "");
}

export async function renderDocx(bytes: Buffer): Promise<string> {
  const result = await mammoth.convertToHtml({ buffer: bytes });
  return stripDangerousHtml(result.value);
}
