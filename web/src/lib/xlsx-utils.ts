// Shared exceljs cell-text extraction, used by both the pricing-schedule
// importer (pricing-import-service.ts) and the generic spreadsheet
// viewer (document-view-service.ts) -- one place for the richText/date/
// number normalization rather than two copies drifting apart.

import type ExcelJS from "exceljs";

export function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "richText" in (value as object)) {
    return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
  }
  if (typeof value === "object" && "result" in (value as object)) {
    // A formula cell -- exceljs exposes both `formula` and its computed `result`.
    return cellText((value as { result: unknown }).result);
  }
  return String(value).trim();
}

// Compact, LLM-prompt-ready text form of an entire workbook -- every
// sheet, every non-empty row up to the cap, cells pipe-separated with a
// "Sheet: X" / "Row N:" prefix so a proposed line item's sourceQuote (a
// cell's own text, read back later via document-view-service.ts's
// findSpreadsheetMatch) stays traceable to roughly where it came from.
// Deliberately flat text, not JSON -- cheaper in tokens for the same
// information, and the model only needs to read it, not round-trip
// structure. Shared by spreadsheet-line-item-service.ts's AI-fallback
// importer and text-extraction.ts's XLSX branch -- one serializer, not
// two independently-drifting ones.
export interface SerializeWorkbookOptions {
  maxRowsPerSheet?: number;
}

export function serializeWorkbookForPrompt(workbook: ExcelJS.Workbook, opts: SerializeWorkbookOptions = {}): string {
  const maxRowsPerSheet = opts.maxRowsPerSheet ?? 300;
  const parts: string[] = [];
  for (const sheet of workbook.worksheets) {
    parts.push(`## Sheet: ${sheet.name}`);
    const rowLimit = Math.min(sheet.rowCount, maxRowsPerSheet);
    for (let r = 1; r <= rowLimit; r++) {
      const row = sheet.getRow(r);
      const cells: string[] = [];
      row.eachCell({ includeEmpty: false }, (cell) => {
        // A merged title/banner cell spanning several columns reports its
        // own text on every cell in the span (confirmed against the real
        // Fuse bid's own banner rows) -- only the merge's master (top-left)
        // cell is emitted, avoiding paying token cost N times for the same
        // words with zero information gain. Deliberately NOT a text-
        // equality dedupe: this file's own Row 6 has three genuinely
        // distinct, unmerged cells that happen to all cost $400 -- an
        // equality-based collapse would silently drop two of those three
        // real numbers.
        if (cell.isMerged && cell.master !== cell) return;
        const text = cellText(cell.value);
        if (text) cells.push(text);
      });
      if (cells.length > 0) parts.push(`Row ${r}: ${cells.join(" | ")}`);
    }
    if (sheet.rowCount > maxRowsPerSheet) {
      parts.push(`(... ${sheet.rowCount - maxRowsPerSheet} more row(s) omitted from "${sheet.name}" -- not necessarily blank, just past the read limit)`);
    }
  }
  return parts.join("\n");
}
