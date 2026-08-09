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

export interface SpreadsheetMatch {
  sheetIndex: number;
  rowIndex: number;
  cellIndex: number;
}

// Finds the exact cell a citation's sourceQuote came from. Unlike
// highlightQuote's regex search over free-form document text, this is a
// straight equality check: pricing-import-service.ts stores a row's own
// Description cell text, verbatim, as sourceQuote -- so the real match
// either exists exactly (normalized for whitespace/case) or the sheet
// changed since the line item was imported.
function normalizeCell(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function findSpreadsheetMatch(sheets: SpreadsheetSheet[], quote: string): SpreadsheetMatch | null {
  const normalized = normalizeCell(quote);
  if (!normalized) return null;
  for (let sheetIndex = 0; sheetIndex < sheets.length; sheetIndex++) {
    const rows = sheets[sheetIndex].rows;
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const cellIndex = rows[rowIndex].findIndex((cell) => normalizeCell(cell) === normalized);
      if (cellIndex !== -1) return { sheetIndex, rowIndex, cellIndex };
    }
  }
  return null;
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

// Wraps the first occurrence of `quote` (a Project Brief citation --
// see document-summary-service.ts's sourceQuote) in a <mark id="hl">,
// so a Link with an #hl fragment auto-scrolls the browser straight to
// it with zero client JS. DOCX has no page concept the way a PDF viewer
// does, so a text-search highlight is the equivalent "jump to it" for
// this file type. A regex over the raw HTML string, not a proper DOM
// text search -- if the quote spans a formatting boundary (e.g. part of
// it is bolded), the match silently fails and the page just doesn't
// scroll, rather than erroring.
export function highlightQuote(html: string, quote: string): string {
  const trimmed = quote.trim();
  if (!trimmed) return html;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const match = html.match(new RegExp(escaped, "i"));
  if (!match || match.index === undefined) return html;
  return (
    html.slice(0, match.index) +
    `<mark id="hl" style="background:#fddfb1;">${match[0]}</mark>` +
    html.slice(match.index + match[0].length)
  );
}
