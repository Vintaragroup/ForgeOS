// Branches by DocumentType, not just mimeType -- PRICING_SCHEDULE and
// DRAWING both skip AI summarization entirely, for different real
// reasons (see each case below), not because extraction failed on them.

import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentType } from "@/generated/prisma/enums";
import { serializeWorkbookForPrompt } from "@/lib/xlsx-utils";

export type ExtractionResult =
  | { status: "COMPLETE"; text: string }
  | { status: "UNSUPPORTED"; reason: string };

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const TEXT_MIME = "text/plain";
// Real-world browser-reported values for a .md file -- unlike .txt (which
// reliably reports text/plain), Markdown's mimeType is inconsistent
// across OS/browser (Chrome on macOS: "text/markdown"; others: empty
// string, or "application/octet-stream"). Both are checked explicitly;
// the empty/octet-stream cases fall back to the filename extension below.
export const MARKDOWN_MIMES = new Set(["text/markdown", "text/x-markdown"]);

export async function extractDocumentText(
  documentType: DocumentType,
  mimeType: string,
  bytes: Buffer,
  // Fallback signal only, for when mimeType comes back empty or generic
  // (see MARKDOWN_MIMES above) -- both real call sites (document-summary-
  // service.ts, meeting-notes-summary-service.ts) already have
  // document.filename in scope. Optional/defaulted so every existing
  // caller (including this file's own tests, none of which exercise the
  // text path) is unaffected.
  filename = "",
): Promise<ExtractionResult> {
  // The Pricing Schedule's own rows (qty/description) are a strictly
  // better structured signal than re-deriving the same facts from raw
  // cell text via an LLM -- see pricing-import-service.ts. Not a failure,
  // just the wrong tool for this document type.
  if (documentType === "PRICING_SCHEDULE") {
    return { status: "UNSUPPORTED", reason: "Pricing schedules are parsed directly, not summarized." };
  }

  // CAD-exported drawings (real example: data/RFP/superbowl's Populous bid
  // set) carry their content as vector geometry and dimension labels, not
  // extractable body text -- unpdf would return an empty/garbled string.
  // Qualitative Q&A about a drawing belongs in chat (vision), not this
  // fixed-shape summarizer.
  if (documentType === "DRAWING") {
    return { status: "UNSUPPORTED", reason: "Drawings aren't text-extractable; ask about them in chat instead." };
  }

  if (mimeType === PDF_MIME) {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    if (!text.trim()) {
      return { status: "UNSUPPORTED", reason: "No extractable text found in this PDF." };
    }
    return { status: "COMPLETE", text };
  }

  if (mimeType === DOCX_MIME) {
    const result = await mammoth.extractRawText({ buffer: bytes });
    if (!result.value.trim()) {
      return { status: "UNSUPPORTED", reason: "No extractable text found in this document." };
    }
    return { status: "COMPLETE", text: result.value };
  }

  // Any XLSX document NOT tagged PRICING_SCHEDULE (that early-return
  // above) -- a vendor bid, a fabrication estimate, anything spreadsheet-
  // shaped uploaded as a Vendor Quote/Contract/Other/etc. Reuses the same
  // serializer spreadsheet-line-item-service.ts's AI-fallback importer
  // uses, so this document becomes visible to the generic summarizer,
  // risk-flag extraction, and scope coverage analysis (all of which only
  // ever look at extractionStatus: COMPLETE) the same way a PDF or DOCX
  // already is -- confirmed live: without this, an XLSX document could
  // never reach COMPLETE at all, making a real $54,993 Rigging package in
  // an unrecognized bid workbook invisible to every AI feature, not just
  // the deterministic importers.
  if (mimeType === XLSX_MIME) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    const text = serializeWorkbookForPrompt(workbook);
    if (!text.trim()) {
      return { status: "UNSUPPORTED", reason: "No extractable content found in this spreadsheet." };
    }
    return { status: "COMPLETE", text };
  }

  // Meeting transcripts/recaps routinely arrive as plain .txt exports
  // (e.g. an auto-generated call-transcription download) -- no parsing
  // needed, just a raw decode. Markdown (design notes, a README-style
  // scope doc, an exported spec) is exactly as trivial -- valid Markdown
  // is valid UTF-8 text, no separate parsing library needed; the AI
  // summarizer already handles the odd stray "#"/"-" formatting character
  // fine as part of the raw text.
  const isUnreliableMimeType = !mimeType || mimeType === "application/octet-stream";
  const looksLikeMarkdownFilename = isUnreliableMimeType && /\.(md|markdown)$/i.test(filename);
  if (mimeType === TEXT_MIME || MARKDOWN_MIMES.has(mimeType) || looksLikeMarkdownFilename) {
    const text = bytes.toString("utf-8");
    if (!text.trim()) {
      return { status: "UNSUPPORTED", reason: "This text file is empty." };
    }
    return { status: "COMPLETE", text };
  }

  return { status: "UNSUPPORTED", reason: `Unsupported file type for text extraction: ${mimeType}` };
}

// Per-page text, used only to locate which page a cited fact's sourceQuote
// came from (see document-summary-service.ts) -- extractDocumentText above
// merges pages because the summarizer/chat only need one blob of text; page
// boundaries only matter for jumping the PDF viewer to the right spot.
export async function extractPdfPageTexts(bytes: Buffer): Promise<string[]> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

// Finds the first page whose text contains the quote (whitespace/case
// normalized, since minor formatting drift between the model's quote and
// the raw extracted text is expected). Falls back to the quote's first 40
// characters if the full quote doesn't match anywhere -- the model
// occasionally quotes a few extra trailing words that cross a page or
// line-wrap boundary unpdf renders differently. Returns 1-indexed page
// number, or null if nothing close enough is found.
export function locateQuotePage(pageTexts: string[], quote: string): number | null {
  const trimmed = quote.trim();
  if (!trimmed) return null;
  const normalizedQuote = normalizeForMatch(trimmed);
  const normalizedPages = pageTexts.map(normalizeForMatch);

  const fullMatch = normalizedPages.findIndex((p) => p.includes(normalizedQuote));
  if (fullMatch !== -1) return fullMatch + 1;

  const prefix = normalizedQuote.slice(0, 40);
  if (prefix.length < 15) return null; // too short to trust a partial match
  const prefixMatch = normalizedPages.findIndex((p) => p.includes(prefix));
  return prefixMatch === -1 ? null : prefixMatch + 1;
}

// A quote that doesn't appear as one unbroken run in the source can't be
// highlighted by anything downstream -- DOCX's regex-based <mark> wrap
// (document-view-service.ts) and Chromium's PDF viewer #search=<text>
// open parameter (the view page's iframe src) both need a genuinely
// contiguous match, or they silently do nothing. Most often this happens
// when a risk flag stitches together a rate and its cap from two separate
// clauses ("Daily rate is 0.5%" ... several sentences later ... "capped
// at 10%") into one "quote" that was never actually adjacent text. Rather
// than let every downstream highlight attempt fail the same way, this
// resolves the quote ONCE against the full extracted document text: the
// quote as-is if it's a real substring, else its first 40 characters
// (same threshold locateQuotePage falls back to) if THAT much is real,
// else the original quote unchanged -- nothing further to be done if even
// a short prefix isn't genuinely contiguous.
export function resolveHighlightableQuote(sourceText: string, quote: string): string {
  const trimmed = quote.trim();
  if (!trimmed) return quote;
  const normalizedSource = normalizeForMatch(sourceText);
  if (normalizedSource.includes(normalizeForMatch(trimmed))) return trimmed;

  const prefix = trimmed.slice(0, 40);
  if (prefix.length >= 15 && normalizedSource.includes(normalizeForMatch(prefix))) return prefix;

  return trimmed;
}
