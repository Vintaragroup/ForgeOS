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
import { BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";

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

// Onboarding fields (opportunities/[id]/page.tsx's ProjectTypeFields) that
// a document's own text might state outright -- a generic array rather
// than one bespoke top-level property per field (like venue/
// eventOrProjectName above) so adding another suggestible field later is
// a one-line change here, not a schema+type+prompt edit everywhere. Dates
// are kept as free text (same as submissionDeadline) and parsed with
// parseFreeTextDate at the point of use, not here.
export type ExtractableOpportunityField =
  | "boothNumber"
  | "boothSize"
  | "shipDate"
  | "eventStartDate"
  | "eventEndDate"
  | "siteAddress";

export const EXTRACTABLE_OPPORTUNITY_FIELDS: ExtractableOpportunityField[] = [
  "boothNumber",
  "boothSize",
  "shipDate",
  "eventStartDate",
  "eventEndDate",
  "siteAddress",
];

export interface ExtractedField {
  field: ExtractableOpportunityField;
  value: string;
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
  // Optional -- older analyzed documents predate this field and won't
  // have it in their stored extractedSummary; treat as an empty array.
  extractedFields?: ExtractedField[];
  // Optional: drawing-summary-service.ts doesn't populate this (a
  // document already in the vision pipeline has no ambiguity left to
  // resolve). Excludes PRICING_SCHEDULE -- that's a mime-type/structure
  // question (see opportunities/[id]/page.tsx's
  // isLikelyMistaggedSpreadsheet), not something inferred from prose.
  suggestedDocumentType?: SuggestableDocumentType;
}

// The real, recurring mistake this catches: a real test job had its
// actual scope-of-work spec and its vendor services agreement both
// uploaded tagged "RFP" -- generically true but not useful, since
// RFP-typed documents get a different candidate list than SCOPE_OF_WORK/
// CONTRACT elsewhere in the app. Suggesting a more specific type from the
// content itself, right when it's already being read anyway, catches this
// without a second AI call.
export const SUGGESTABLE_DOCUMENT_TYPES = [
  "RFP",
  "SCOPE_OF_WORK",
  "CONTRACT",
  "SCHEDULE",
  "DRAWING",
  "OTHER",
] as const;
export type SuggestableDocumentType = (typeof SUGGESTABLE_DOCUMENT_TYPES)[number];

// What OpenAI actually returns -- pageNumber added in a pass afterward,
// so it's absent from both the schema and this intermediate type.
type DocumentSummaryFromAI = {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: { label: string; date: string; dateType: KeyDateType; sourceQuote: string }[];
  scopeSummary: { text: string; sourceQuote: string }[];
  riskFlags: { text: string; sourceQuote: string }[];
  extractedFields: { field: ExtractableOpportunityField; value: string; sourceQuote: string }[];
  suggestedDocumentType: SuggestableDocumentType;
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
      extractedFields: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: {
              type: "string",
              enum: EXTRACTABLE_OPPORTUNITY_FIELDS,
              description:
                "boothNumber: the exhibitor's assigned booth number. boothSize: booth footprint as written, e.g. '20x20' or '10 x 30'. shipDate: when materials/freight must ship or arrive at the show, distinct from any move-in date. eventStartDate/eventEndDate: the show or event's own open-to-public dates, distinct from installation/move-in and dismantle/move-out dates. siteAddress: a physical jobsite address for non-show work (e.g. a permanent install or on-site build), not a show venue name.",
            },
            value: { type: "string", description: "The fact as written in the source -- dates as free text, not reformatted." },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
          },
          required: ["field", "value", "sourceQuote"],
        },
      },
      suggestedDocumentType: {
        type: "string",
        enum: SUGGESTABLE_DOCUMENT_TYPES,
        description:
          "The document TYPE this content actually reads as, regardless of how it's currently filed. RFP: an invitation/instructions to bid. SCOPE_OF_WORK: describes the deliverables/work to be done. CONTRACT: a services agreement, terms and conditions, or legal agreement. SCHEDULE: primarily a timeline, event schedule, or list of dates. DRAWING: primarily dimensions/technical drawing callouts (rare for a text document -- most drawings are images). OTHER: none of the above fit well.",
      },
    },
    required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags", "extractedFields", "suggestedDocumentType"],
  },
} as const;

const SYSTEM_PROMPT = `You analyze RFP and client-supplied project documents for a contractor whose work spans tradeshow exhibits, standalone events, exhibitor I&D/labor contracting, and specialized/experiential builds -- not every document is about a booth. Extract only facts stated in the document -- never infer or guess a date, name, or figure that isn't written there. If something isn't present, use null or an empty array. Keep scopeSummary and riskFlags as short, specific bullet points, not paragraphs. For every key date, scope item, risk flag, and extracted field, include sourceQuote: a short verbatim quote copied exactly from the document showing where that fact came from -- this is used to jump a reader straight to it, so it must be an exact substring of the source text, not a paraphrase.

For every key date, also classify dateType from the READER's point of view, not the document author's: a date is only a DEADLINE if the reader (the bidder/contractor) must submit, respond, or deliver something by it. "RFP Sent" or "Answers to Bidders' Questions Sent" are INFORMATIONAL -- they're facts about what the client already did, not something the reader owes anyone. "Potential Site Visit" or "Opening Night" are MILESTONE -- fixed points in the event worth planning around, but nothing is due from the reader that day. "Bidder Questions Due" or "Tender Submission Due" are DEADLINE -- the reader must act by then. Get this classification right; a Dashboard view uses it to decide what actually belongs in a deadlines list versus a timeline.

Also extract extractedFields: onboarding facts about the job itself (booth number, booth size, ship date, event start/end dates, jobsite address) whenever the document states them plainly -- these get proposed to a human as suggestions to accept or ignore, never applied automatically, so extract anything genuinely stated even if you're not certain it's the final value.

Also classify suggestedDocumentType: what this document's content actually IS, independent of how it happens to be filed right now -- a vendor services agreement is a CONTRACT even if it was uploaded as a generic RFP attachment.`;

// Truncated, not chunked -- this app has no RAG/embedding infra (see
// chat-context-service.ts's same budget approach). This used to be
// 60_000 on the (wrong) assumption that every real document stays under
// it -- a real Super Bowl 2026 Vendor Services Agreement is actually
// 84,125 characters, so the old cap silently dropped the last ~29% of
// that contract from extractedText forever (every future reader --
// Risk Flags, Key Dates, Scope Summary, chat, scope-coverage-service.ts,
// clarification-questions-service.ts -- inherited the gap with no
// indication anything was missing). BASIC_MODEL is cheap enough that a
// much larger ceiling costs a fraction of a cent extra per document.
const MAX_INPUT_CHARS = 150_000;

export async function summarizeDocument(documentId: string, userId: string | null = null) {
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
      model: BASIC_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Document: ${document.filename}\n\n${extraction.text.slice(0, MAX_INPUT_CHARS)}` },
      ],
      response_format: { type: "json_schema", json_schema: SUMMARY_SCHEMA },
    });

    await recordAiUsage({
      userId,
      feature: "DOCUMENT_SUMMARY",
      model: BASIC_MODEL,
      usage: completion.usage,
      documentId,
      opportunityId: document.opportunityId,
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
      extractedFields: withPage(parsed.extractedFields),
      suggestedDocumentType: parsed.suggestedDocumentType,
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
