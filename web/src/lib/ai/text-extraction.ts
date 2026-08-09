// Branches by DocumentType, not just mimeType -- PRICING_SCHEDULE and
// DRAWING both skip AI summarization entirely, for different real
// reasons (see each case below), not because extraction failed on them.

import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import type { DocumentType } from "@/generated/prisma/enums";

export type ExtractionResult =
  | { status: "COMPLETE"; text: string }
  | { status: "UNSUPPORTED"; reason: string };

export const PDF_MIME = "application/pdf";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function extractDocumentText(
  documentType: DocumentType,
  mimeType: string,
  bytes: Buffer,
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
