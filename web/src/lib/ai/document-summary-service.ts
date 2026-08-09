// Phase 7.2: one Structured Outputs call per text-bearing document,
// producing a fixed JSON shape rather than free-form prose -- so the
// Project Brief panel (opportunities/[id]/page.tsx) can render it without
// re-parsing an LLM's prose output. See data/RFP/superbowl for the real
// documents this schema was designed against: the RFP's own key dates
// (Appendix A), Schedule A's scope bullets, and the Vendor Services
// Agreement's liquidated-damages/insurance risk terms.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import {
  extractDocumentText,
  extractPdfPageTexts,
  locateQuotePage,
  resolveHighlightableQuote,
  PDF_MIME,
} from "@/lib/ai/text-extraction";
import { DEFAULT_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";

// pageNumber is never asked of the model -- it's computed afterward by
// searching the PDF's own per-page text for sourceQuote (see
// locateQuotePage below), so it's trustworthy in a way an LLM-reported
// page number wouldn't be. null for DOCX (no page concept) or when the
// quote couldn't be located.
//
// dateType IS asked of the model -- distinguishing "we must act by this
// date" from "this is just when the event happens" from "this already
// happened, it's a fact" isn't something a page-search can compute, only
// reading comprehension can. Without it, a Dashboard/deadlines view has no
// way to tell "Bidder Questions Due" (a real deadline) apart from "RFP
// Sent" (a fact about something the client already did) -- both are just
// dates otherwise.
export type KeyDateType = "DEADLINE" | "MILESTONE" | "INFORMATIONAL";

export interface KeyDateFact {
  label: string;
  date: string;
  dateType: KeyDateType;
  sourceQuote: string;
  pageNumber: number | null;
}
export interface CitedText {
  text: string;
  sourceQuote: string;
  pageNumber: number | null;
}

export interface DocumentSummary {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: KeyDateFact[];
  scopeSummary: CitedText[];
  riskFlags: CitedText[];
}

// What OpenAI actually returns -- pageNumber added in a pass afterward,
// so it's absent from both the schema and this intermediate type.
type DocumentSummaryFromAI = {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: { label: string; date: string; dateType: KeyDateType; sourceQuote: string }[];
  scopeSummary: { text: string; sourceQuote: string }[];
  riskFlags: { text: string; sourceQuote: string }[];
};

const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from the document text above, showing where this fact is stated. Never paraphrase or summarize the quote itself.";

const SUMMARY_SCHEMA = {
  name: "document_summary",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      eventOrProjectName: { type: ["string", "null"] },
      venue: { type: ["string", "null"] },
      submissionDeadline: { type: ["string", "null"], description: "Free-text date, as written in the source." },
      keyDates: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            date: { type: "string" },
            dateType: {
              type: "string",
              enum: ["DEADLINE", "MILESTONE", "INFORMATIONAL"],
              description:
                "From the READER's point of view (the contractor/bidder, not the client who wrote this document). " +
                "DEADLINE: the reader must submit, respond, or deliver something by this date -- a hard cutoff for outbound action (e.g. 'Bidder Questions Due', 'Tender Submission Due', 'Dismantle Complete'). " +
                "MILESTONE: a fixed date or window in the event itself, worth tracking for planning, but the reader isn't required to act or submit anything by it (e.g. 'Potential Site Visit', 'Opening Night', 'Game Day', an install date). " +
                "INFORMATIONAL: states something the CLIENT already did or will do -- not an action item for the reader at all (e.g. 'RFP Sent', 'Answers to Bidders' Questions Sent', an award notification date).",
            },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
          },
          required: ["label", "date", "dateType", "sourceQuote"],
        },
      },
      scopeSummary: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
          },
          required: ["text", "sourceQuote"],
        },
      },
      riskFlags: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", description: "Contract/compliance risk worth a human's attention -- liquidated damages, insurance minimums, credentialing deadlines, etc." },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
          },
          required: ["text", "sourceQuote"],
        },
      },
    },
    required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags"],
  },
} as const;

const SYSTEM_PROMPT = `You analyze RFP and client-supplied project documents for an event/exhibit contractor. Extract only facts stated in the document -- never infer or guess a date, name, or figure that isn't written there. If something isn't present, use null or an empty array. Keep scopeSummary and riskFlags as short, specific bullet points, not paragraphs. For every key date, scope item, and risk flag, include sourceQuote: a short verbatim quote copied exactly from the document showing where that fact came from -- this is used to jump a reader straight to it, so it must be an exact substring of the source text, not a paraphrase.

For every key date, also classify dateType from the READER's point of view, not the document author's: a date is only a DEADLINE if the reader (the bidder/contractor) must submit, respond, or deliver something by it. "RFP Sent" or "Answers to Bidders' Questions Sent" are INFORMATIONAL -- they're facts about what the client already did, not something the reader owes anyone. "Potential Site Visit" or "Opening Night" are MILESTONE -- fixed points in the event worth planning around, but nothing is due from the reader that day. "Bidder Questions Due" or "Tender Submission Due" are DEADLINE -- the reader must act by then. Get this classification right; a Dashboard view uses it to decide what actually belongs in a deadlines list versus a timeline.`;

// Truncated, not chunked -- this app has no RAG/embedding infra (see
// chat-context-service.ts's same budget approach), and a single document's
// text staying under this is true for every real sample in
// data/RFP/superbowl.
const MAX_INPUT_CHARS = 60_000;

export async function summarizeDocument(documentId: string) {
  const { document, bytes } = await getDocumentBytes(documentId);

  // Type-based UNSUPPORTED cases (PRICING_SCHEDULE, DRAWING) never call
  // OpenAI at all -- resolved before the config check below so they work
  // regardless of whether a key is configured.
  const extraction = await extractDocumentText(document.documentType, document.mimeType, bytes);

  if (extraction.status === "UNSUPPORTED") {
    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "UNSUPPORTED", extractedText: null },
    });
  }

  // Checked before any DB write for a text-bearing document -- a missing
  // key is a configuration problem the caller surfaces distinctly (see
  // analyzeDocumentAction), and must leave the document exactly as it was
  // (PENDING, retryable) rather than stuck at PROCESSING with no Analyze
  // button to try again once a key is added.
  const client = getOpenAiClient();

  await db.document.update({
    where: { id: documentId },
    data: { extractionStatus: "PROCESSING", extractedText: extraction.text.slice(0, MAX_INPUT_CHARS) },
  });

  try {
    const completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Document: ${document.filename}\n\n${extraction.text.slice(0, MAX_INPUT_CHARS)}` },
      ],
      response_format: { type: "json_schema", json_schema: SUMMARY_SCHEMA },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response.");
    const parsed = JSON.parse(content) as DocumentSummaryFromAI;

    // Page numbers are computed here, not asked of the model -- searching
    // the PDF's own per-page text for each sourceQuote is trustworthy in a
    // way an LLM-reported page number wouldn't be. DOCX has no page
    // concept; those facts stay pageNumber: null and get a text-search
    // highlight in the viewer instead (document-view-service.ts).
    const pageTexts = document.mimeType === PDF_MIME ? await extractPdfPageTexts(bytes) : null;
    // sourceQuote is resolved against the full extracted text BEFORE page
    // lookup, not after -- a quote that isn't a genuine contiguous
    // substring can't be highlighted by the viewer no matter what page
    // it's on, so both page lookup and the in-viewer highlight use the
    // same corrected quote (see resolveHighlightableQuote).
    const withPage = <T extends { sourceQuote: string }>(items: T[]): (T & { pageNumber: number | null })[] =>
      items.map((item) => {
        const sourceQuote = resolveHighlightableQuote(extraction.text, item.sourceQuote);
        return { ...item, sourceQuote, pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null };
      });

    const summary: DocumentSummary = {
      eventOrProjectName: parsed.eventOrProjectName,
      venue: parsed.venue,
      submissionDeadline: parsed.submissionDeadline,
      keyDates: withPage(parsed.keyDates),
      scopeSummary: withPage(parsed.scopeSummary),
      riskFlags: withPage(parsed.riskFlags),
    };

    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "COMPLETE", extractedSummary: summary as unknown as Prisma.InputJsonObject },
    });
  } catch {
    // A transient/API failure is retryable by clicking Analyze again --
    // record it as FAILED rather than throwing, so the Server Action
    // completes normally and the UI reflects it via the status chip.
    // instrumentation.ts's onRequestError hook deliberately won't see
    // this: a per-document analysis failure isn't a request-level error.
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
}
