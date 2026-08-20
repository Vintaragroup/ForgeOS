// In-app document viewing -- separate from ai/text-extraction.ts, which
// extracts PLAIN text for the AI summarizer/chat. This produces
// structured/HTML output meant for a human to actually read in the
// browser: every sheet of a spreadsheet as a real table (not just the
// pricing-schedule shape pricing-import-service.ts looks for), and a
// Word document as formatted HTML, not a wall of extracted text.

import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { getDocumentProxy, extractTextItems, createIsomorphicCanvasFactory, type StructuredTextItem } from "unpdf";
import type { Canvas, SKRSContext2D } from "@napi-rs/canvas";
import sanitizeHtml from "sanitize-html";
import { cellText } from "@/lib/xlsx-utils";

// Item #2 of the security/hardening roadmap: this used to be a hand-
// rolled regex blocklist (strip <script>, strip on*= attributes) -- a
// known-weak pattern (bypassable via malformed/nested tags, <svg
// onload=>, etc.) even though mammoth's own HTML output isn't fully
// attacker-controlled arbitrary text. sanitize-html is an allowlist
// sanitizer instead: anything not explicitly permitted is stripped,
// regardless of what shape the dangerous content takes.
//
// Originally DOMPurify(jsdom) instead -- switched after a real production
// outage: jsdom's html-encoding-sniffer dependency requires @exodus/bytes,
// which is ESM-only, and Node's require() can't load it inside Vercel's
// serverless bundle (confirmed from the installed packages' own
// package.json, not a guess) -- "Failed to load external module jsdom...
// ERR_REQUIRE_ESM" on every single /view request, 100% reproducible, not
// something serverExternalPackages could fix since the failure is inside
// jsdom's own require() chain, not Next's bundling of it. sanitize-html
// has no DOM dependency at all, so this whole failure class doesn't exist
// for it. img added on top of the defaults (not included there) since
// DOMPurify's default allowlist -- what this app shipped with before --
// did allow it, and mammoth embeds DOCX images as data: URIs.
const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img"]),
  allowedAttributes: sanitizeHtml.defaults.allowedAttributes,
  allowedSchemesByTag: { img: ["data", "http", "https"] },
};

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
// realistically reachable -- still, a real allowlist sanitizer costs
// nothing given this renders via dangerouslySetInnerHTML, and closes off
// the whole class of bypass a blocklist can't rule out (malformed/nested
// tags, an <svg onload=...>, etc.), not just the two shapes the old
// regex happened to name.
// Exported (not just used internally by renderDocx) so the regression
// tests below can prove concrete bypasses of the OLD regex blocklist --
// e.g. an unquoted or single-quoted event handler attribute, which
// `/\son\w+="[^"]*"/gi` never matched at all -- are actually caught now,
// not just that the one shape the old regex happened to name still is.
export function stripDangerousHtml(html: string): string {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
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

// PDF has no DOM the way DOCX/XLSX's server-rendered HTML does, and the
// browser's own embedded PDF viewer offers no reliable, verifiable way to
// highlight a search term inside it (an earlier #search=<text> open-
// parameter attempt was confirmed not working) -- so instead of trying to
// highlight inside the interactive viewer, this renders just the cited
// page as a static image with the matched text actually marked on it,
// shown above the full iframe viewer as a "here it is" companion, not a
// replacement. Uses unpdf's already-installed getDocumentProxy/
// extractTextItems/createIsomorphicCanvasFactory -- the exact same
// page-to-image pipeline drawing-summary-service.ts's pageImages already
// uses in production, just with a highlight rectangle drawn on top before
// encoding. No new dependency.
function normalizeForPdfMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

interface PdfItemSpan {
  itemIndex: number;
  start: number;
  end: number;
}

// Concatenates a page's text items with NO inserted separator by default
// -- pdf.js's own extraction already materializes a real word-gap as its
// own whitespace item (see unpdf's pushWhitespace), so two adjacent items
// with nothing between them means there's genuinely no space in the
// source (e.g. a font/style change mid-word). Only hasEOL gets a space
// appended, mirroring unpdf's own extractText line-join behavior, so a
// quote crossing a line break still matches. Tracks each item's offset
// range in the normalized string so a matched character range can be
// mapped back to which item(s) to highlight.
function buildNormalizedIndex(items: StructuredTextItem[]): { normalized: string; spans: PdfItemSpan[] } {
  let normalized = "";
  const spans: PdfItemSpan[] = [];
  for (let i = 0; i < items.length; i++) {
    const raw = (items[i].str + (items[i].hasEOL ? " " : "")).toLowerCase();
    const start = normalized.length;
    for (const ch of raw) {
      if (/\s/.test(ch)) {
        if (normalized.length > 0 && !normalized.endsWith(" ")) normalized += " ";
      } else {
        normalized += ch;
      }
    }
    spans.push({ itemIndex: i, start, end: normalized.length });
  }
  if (normalized.endsWith(" ")) normalized = normalized.slice(0, -1);
  return { normalized, spans };
}

// Same full-match-else-40-char-prefix-fallback convention as
// text-extraction.ts's locateQuotePage/resolveHighlightableQuote,
// reimplemented rather than imported -- this operates over a differently
// tokenized layer (per-text-item, not the merged-page plain text those
// functions verify a quote against), so the same quote isn't guaranteed
// to be a clean substring here even though it already was there.
function matchPdfQuoteRange(normalized: string, quote: string): { start: number; end: number } | null {
  const normalizedQuote = normalizeForPdfMatch(quote);
  if (!normalizedQuote) return null;
  const fullIndex = normalized.indexOf(normalizedQuote);
  if (fullIndex !== -1) return { start: fullIndex, end: fullIndex + normalizedQuote.length };
  const prefix = normalizedQuote.slice(0, 40);
  if (prefix.length < 15) return null;
  const prefixIndex = normalized.indexOf(prefix);
  return prefixIndex === -1 ? null : { start: prefixIndex, end: prefixIndex + prefix.length };
}

const PDF_HIGHLIGHT_COLOR = "rgba(253, 223, 177, 0.55)"; // #fddfb1 amber -- same as ReferencedExcerpt/highlightQuote, semi-transparent so the underlying text stays legible

// Returns a PNG data URL of just the given page with the matched quote
// highlighted, or null if no confident match is found -- a graceful
// degrade, not an error: the caller falls back to today's callout box +
// full iframe, unchanged. One rectangle per matched text item (a
// multi-line or multi-style quote can span several), not one merged box
// -- matches how a real PDF viewer's own selection renders a multi-line
// match. Assumes page.rotate === 0, same as every other page-text
// consumer in this codebase (locateQuotePage, pageImages) -- not handled.
export async function renderHighlightedPdfPage(bytes: Buffer, pageNumber: number, quote: string): Promise<string | null> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { items } = await extractTextItems(pdf);
  const pageItems = items[pageNumber - 1];
  if (!pageItems || pageItems.length === 0) return null;

  const { normalized, spans } = buildNormalizedIndex(pageItems);
  const range = matchPdfQuoteRange(normalized, quote);
  if (!range) return null;

  const matchedItems = spans
    .filter((s) => s.end > range.start && s.start < range.end)
    .map((s) => pageItems[s.itemIndex])
    .filter((item) => item.width > 0 && item.height > 0);
  if (matchedItems.length === 0) return null;

  const page = await pdf.getPage(pageNumber);
  const defaultViewport = page.getViewport({ scale: 1 });
  const scale = 2; // matches drawing-summary-service.ts's pageImages scale
  const viewport = page.getViewport({ scale });
  const pageHeight = defaultViewport.height;

  const CanvasFactory = await createIsomorphicCanvasFactory(() => import("@napi-rs/canvas"));
  const canvasFactory = new CanvasFactory();
  const drawingContext = canvasFactory.create(viewport.width, viewport.height);
  try {
    // pdf.js's own TS types are browser-flavored (HTMLCanvasElement /
    // CanvasRenderingContext2D); the Node canvas factory's @napi-rs/canvas
    // objects satisfy the same runtime interface pdf.js actually calls
    // against (same pattern unpdf's own renderPageAsImage relies on
    // internally, just untyped there since it's plain JS) -- proven
    // against a real page before this was wired in, see this function's
    // header comment.
    await page.render({
      canvas: drawingContext.canvas as unknown as HTMLCanvasElement,
      canvasContext: drawingContext.context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    // PDF space: bottom-left origin, y up, item.y is the text baseline
    // with item.height extending upward from it. Canvas space: top-left
    // origin, y down. All four item fields need the same * scale
    // conversion despite width/height being labeled "device space" in
    // unpdf's own types -- verified against pdf.js's own extraction
    // internals, and against a real rendered page, before wiring this in.
    const ctx = drawingContext.context as SKRSContext2D;
    ctx.fillStyle = PDF_HIGHLIGHT_COLOR;
    for (const item of matchedItems) {
      ctx.fillRect(
        item.x * scale,
        (pageHeight - (item.y + item.height)) * scale,
        item.width * scale,
        item.height * scale,
      );
    }

    const buffer = await (drawingContext.canvas as Canvas).encode("png");
    return `data:image/png;base64,${buffer.toString("base64")}`;
  } finally {
    canvasFactory.destroy(drawingContext);
  }
}
