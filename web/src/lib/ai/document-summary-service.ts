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
  type ExtractionResult,
} from "@/lib/ai/text-extraction";
import { ADVANCED_MODEL, BASIC_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { getProjectContext, resolveProjectTag } from "@/lib/ai/scope-document-context";
import { indexDocument } from "@/lib/ai/document-embedding-service";

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

// estimateId is optional (not just nullable) so an already-stored
// summary from before multi-project support still parses cleanly --
// `undefined` is treated identically to an explicit `null` everywhere
// this is read (both mean "shared/unclassified," visible regardless of
// which Estimate is asking). Only ever meaningful once an Opportunity
// has 2+ Estimates -- resolved server-side against real Estimate rows,
// never trusted raw from a model response, same discipline as every
// other id this session resolves rather than accepts on faith. See
// resolveEstimateProjectTag in scope-document-context.ts.
export interface KeyDateFact {
  label: string;
  date: string;
  dateType: KeyDateType;
  sourceQuote: string;
  pageNumber: number | null;
  estimateId?: string | null;
}
export interface CitedText {
  text: string;
  sourceQuote: string;
  pageNumber: number | null;
  estimateId?: string | null;
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
  // Optional, same reason as extractedFields above -- older analyzed
  // documents predate this field. This is the compact, purpose-built
  // input scope-coverage-service.ts / clarification-questions-service.ts
  // reason over instead of raw extractedText: each bullet is a specific
  // spec/parameter/responsibility THIS document alone leaves incomplete
  // or ambiguous, extracted here (by the cheap model, reading the FULL
  // document text) so the expensive cross-document reasoning model never
  // needs the raw text at all -- see scope-document-context.ts's
  // buildBulletsBlock. Re-analyze a document to backfill this on an
  // older summary.
  candidateGaps?: CitedText[];
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
  "MEETING_NOTES",
  "VENDOR_QUOTE",
  "OTHER",
] as const;
export type SuggestableDocumentType = (typeof SUGGESTABLE_DOCUMENT_TYPES)[number];

// What OpenAI actually returns -- pageNumber added in a pass afterward,
// so it's absent from both the schema and this intermediate type. project
// is only ever present when the request schema asked for it (2+ named
// Estimates on this opportunity) -- see buildSummarySchema.
type DocumentSummaryFromAI = {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: { label: string; date: string; dateType: KeyDateType; sourceQuote: string; project?: string }[];
  scopeSummary: { text: string; sourceQuote: string; project?: string }[];
  riskFlags: { text: string; sourceQuote: string; project?: string }[];
  candidateGaps: { text: string; sourceQuote: string; project?: string }[];
  extractedFields: { field: ExtractableOpportunityField; value: string; sourceQuote: string }[];
  suggestedDocumentType: SuggestableDocumentType;
};

const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from the document text above, showing where this fact is stated. Never paraphrase or summarize the quote itself.";

// Splices a `project` property into an item schema's properties/required
// -- only when this opportunity actually has 2+ named Estimates.
// projectNames.length === 0 (the overwhelming common, single-estimate
// case) returns the item schema completely unchanged: no extra property,
// no extra required field, no extra token cost for every analysis this
// app runs. Not applied to extractedFields -- those are single Opportunity-
// level columns (eventStartDate, boothNumber, ...), inherently ambiguous
// once two projects exist, so multi-project opportunities skip
// auto-populating them entirely instead (see opportunity-service.ts's
// applyExtractedFieldsToOpportunity guard).
export function withProjectField<
  P extends Record<string, unknown>,
  R extends readonly string[],
>(itemSchema: { properties: P; required: R }, projectNames: string[]): { properties: P; required: readonly string[] } {
  if (projectNames.length === 0) return itemSchema;
  return {
    properties: {
      ...itemSchema.properties,
      project: {
        type: "string",
        description:
          `Which project this belongs to. Respond with EXACTLY one of: ${projectNames.map((n) => JSON.stringify(n)).join(", ")} -- or "SHARED" if it genuinely applies to more than one of these.`,
      },
    },
    required: [...itemSchema.required, "project"],
  };
}

function buildSummarySchema(projectNames: string[]) {
  return {
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
            ...withProjectField(
              {
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
              projectNames,
            ),
          },
        },
        scopeSummary: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            ...withProjectField(
              {
                properties: {
                  text: { type: "string" },
                  sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
                },
                required: ["text", "sourceQuote"],
              },
              projectNames,
            ),
          },
        },
        riskFlags: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            ...withProjectField(
              {
                properties: {
                  text: { type: "string", description: "Contract/compliance risk worth a human's attention -- liquidated damages, insurance minimums, credentialing deadlines, etc." },
                  sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
                },
                required: ["text", "sourceQuote"],
              },
              projectNames,
            ),
          },
        },
        candidateGaps: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            ...withProjectField(
              {
                properties: {
                  text: {
                    type: "string",
                    description:
                      "A specific spec, parameter, quantity, or responsibility that THIS document alone leaves incomplete, unitless, or ambiguous -- e.g. a requirement with no target range or units, a responsibility with no named owner, two parts of this same document stating different numbers for the same thing. Not a paraphrase of the whole document, and not something this document already answers elsewhere in its own text.",
                  },
                  sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
                },
                required: ["text", "sourceQuote"],
              },
              projectNames,
            ),
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
            "The document TYPE this content actually reads as, regardless of how it's currently filed. RFP: an invitation/instructions to bid. SCOPE_OF_WORK: describes the deliverables/work to be done. CONTRACT: a services agreement, terms and conditions, or legal agreement. SCHEDULE: primarily a timeline, event schedule, or list of dates. DRAWING: primarily dimensions/technical drawing callouts (rare for a text document -- most drawings are images). MEETING_NOTES: a meeting transcript, recap, or email thread -- conversational or narrative, not a formal deliverable. VENDOR_QUOTE: a third party's own priced bid/quote for goods, labor, or services -- lists line items with unit prices or a total cost the vendor is charging, distinct from CONTRACT (terms/agreement language, not itemized pricing) and from this contractor's own outgoing RFP. OTHER: none of the above fit well.",
        },
      },
      required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags", "candidateGaps", "extractedFields", "suggestedDocumentType"],
    },
  };
}

function buildSystemPrompt(projectNames: string[]): string {
  const base = `You analyze RFP and client-supplied project documents for a contractor whose work spans tradeshow exhibits, standalone events, exhibitor I&D/labor contracting, and specialized/experiential builds -- not every document is about a booth. Extract only facts stated in the document -- never infer or guess a date, name, or figure that isn't written there. If something isn't present, use null or an empty array. Keep scopeSummary and riskFlags as short, specific bullet points, not paragraphs. For every key date, scope item, risk flag, and extracted field, include sourceQuote: a short verbatim quote copied exactly from the document showing where that fact came from -- this is used to jump a reader straight to it, so it must be an exact substring of the source text, not a paraphrase.

For every key date, also classify dateType from the READER's point of view, not the document author's: a date is only a DEADLINE if the reader (the bidder/contractor) must submit, respond, or deliver something by it. "RFP Sent" or "Answers to Bidders' Questions Sent" are INFORMATIONAL -- they're facts about what the client already did, not something the reader owes anyone. "Potential Site Visit" or "Opening Night" are MILESTONE -- fixed points in the event worth planning around, but nothing is due from the reader that day. "Bidder Questions Due" or "Tender Submission Due" are DEADLINE -- the reader must act by then. Get this classification right; a Dashboard view uses it to decide what actually belongs in a deadlines list versus a timeline.

Also extract candidateGaps: specific things stated in THIS document alone that are incomplete, unitless, contradictory, or leave a responsibility unclear -- the kind of gap a seasoned professional would want clarified before pricing or executing the work confidently (e.g. "temperature-controlled" with no target range, a requirement with no named owner, two sections of this same document stating different numbers for the same thing). Do not flag something this document already answers elsewhere in its own text, and do not flag routine administrative/procedural details (submission format, contacts, deadline logistics). An empty array is correct when this document has no such gaps. This is a candidate list for a later cross-document review that also has access to every other document, so note anything plausible even if a broader read might resolve it -- that later step, not you, makes the final call on what's worth asking about.

Also extract extractedFields: onboarding facts about the job itself (booth number, booth size, ship date, event start/end dates, jobsite address) whenever the document states them plainly -- these get proposed to a human as suggestions to accept or ignore, never applied automatically, so extract anything genuinely stated even if you're not certain it's the final value.

Also classify suggestedDocumentType: what this document's content actually IS, independent of how it happens to be filed right now -- a vendor services agreement is a CONTRACT even if it was uploaded as a generic RFP attachment. A document that is itself mostly a table of priced line items -- a third-party supplier's own quote, bid, or invoice, charging the reader for goods/labor/services -- is VENDOR_QUOTE, even if it also mentions dates or scope in passing; don't classify it as SCHEDULE or SCOPE_OF_WORK just because it contains some of those facts too.`;

  if (projectNames.length === 0) return base;

  return (
    base +
    `\n\nThis client relationship covers multiple separate projects: ${projectNames.map((n) => `"${n}"`).join(", ")}. For every key date, scope item, risk flag, and candidate gap, classify which one it belongs to using the project field on that item -- respond with the exact project name it's about, or "SHARED" only if it genuinely applies to more than one (e.g. a general billing/contact fact). Get this right: a wrong attribution makes one project's estimate look like it's missing something the other project actually needed, or vice versa.`
  );
}

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
  let loaded: { document: Awaited<ReturnType<typeof getDocumentBytes>>["document"]; bytes: Buffer; extraction: ExtractionResult };
  try {
    const { document, bytes } = await getDocumentBytes(documentId);
    // Type-based UNSUPPORTED cases (PRICING_SCHEDULE, DRAWING) never call
    // OpenAI at all -- resolved before the config check below so they work
    // regardless of whether a key is configured.
    const extraction = await extractDocumentText(document.documentType, document.mimeType, bytes, document.filename);
    loaded = { document, bytes, extraction };
  } catch {
    // Same retry posture as the OpenAI-call catch below -- a storage
    // object that no longer exists for this Document row (confirmed real:
    // a stale row from before the Blob migration) previously crashed the
    // whole Server Action with an unhandled error instead of landing here,
    // leaving the document's extractionStatus exactly as it was (often
    // still COMPLETE from a prior run) with no visible sign the retry
    // failed at all.
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
  const { document, bytes, extraction } = loaded;

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

  // A manually-tagged document (see Document.estimateId) already has a
  // known answer -- skip asking the model to classify at all, both to
  // save tokens and because a human-confirmed tag beats an AI guess.
  // Only a genuinely untagged document, on an Opportunity with 2+ named
  // Estimates, gets project classification requested per-item.
  const projectContext = document.estimateId ? { estimates: [] } : await getProjectContext(document.opportunityId);
  const projectNames = projectContext.estimates.map((e) => e.name);
  // Correctly attributing a fact to one of two real projects is a
  // judgment call (surrounding context, not keyword matching), the same
  // class of cross-topic reasoning Scope Coverage/Clarification
  // Questions reserve ADVANCED_MODEL for -- confirmed necessary by a
  // real test where BASIC_MODEL misattributed unambiguous content
  // between two projects (see meeting-notes-summary-service.ts's own
  // comment for the specific case). Single-project extraction (the
  // common case, projectNames empty) stays on BASIC_MODEL -- nothing to
  // misclassify when there's only one project.
  const model = projectNames.length > 0 ? ADVANCED_MODEL : BASIC_MODEL;

  try {
    const completion = await client.chat.completions.create({
      model,
      // Low, not zero -- this is exhaustive extraction (every key date,
      // scope bullet, candidate gap actually present), not creative
      // writing, so the API default's high randomness only costs
      // completeness here. See clarification-questions-service.ts's own
      // comment for the measured run-to-run variance this addresses --
      // candidateGaps in particular feeds a downstream feature that's
      // sensitive to a document's extraction being thorough every time,
      // not just on a lucky sample.
      temperature: 0.2,
      messages: [
        { role: "system", content: buildSystemPrompt(projectNames) },
        { role: "user", content: `Document: ${document.filename}\n\n${extraction.text.slice(0, MAX_INPUT_CHARS)}` },
      ],
      response_format: { type: "json_schema", json_schema: buildSummarySchema(projectNames) },
    });

    await recordAiUsage({
      userId,
      feature: "DOCUMENT_SUMMARY",
      model,
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

    // Same as withPage, but also resolves each item's model-reported
    // `project` string (present only when projectNames was non-empty)
    // against real Estimate rows -- see resolveProjectTag. A manually-
    // tagged document never asked for `project` in the first place, so
    // every item just inherits document.estimateId directly.
    const withPageAndEstimate = <T extends { sourceQuote: string; project?: string }>(
      items: T[],
    ): (Omit<T, "project"> & { pageNumber: number | null; estimateId: string | null })[] =>
      items.map(({ project, ...rest }) => {
        const sourceQuote = resolveHighlightableQuote(extraction.text, rest.sourceQuote);
        return {
          ...rest,
          sourceQuote,
          pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
          estimateId: document.estimateId ?? resolveProjectTag(project, projectContext),
        };
      });

    const summary: DocumentSummary = {
      eventOrProjectName: parsed.eventOrProjectName,
      venue: parsed.venue,
      submissionDeadline: parsed.submissionDeadline,
      keyDates: withPageAndEstimate(parsed.keyDates),
      scopeSummary: withPageAndEstimate(parsed.scopeSummary),
      riskFlags: withPageAndEstimate(parsed.riskFlags),
      candidateGaps: withPageAndEstimate(parsed.candidateGaps),
      extractedFields: withPage(parsed.extractedFields),
      suggestedDocumentType: parsed.suggestedDocumentType,
    };

    const updated = await db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "COMPLETE", extractedSummary: summary as unknown as Prisma.InputJsonObject },
    });

    // Best-effort: an embedding-call failure here shouldn't undo an
    // otherwise-successful analysis. A chat question about this document
    // still works either way -- chat-context-service.ts falls back to
    // this document's full text until it has chunks to retrieve from.
    // Still logged, though -- a silent catch here is exactly how a
    // document can sit unindexed indefinitely with no trace of why (see
    // scripts/backfill-document-embeddings.ts's own header comment).
    await indexDocument(documentId, document.opportunityId, extraction.text, userId).catch((err) => {
      console.warn(
        `[document-index-failed] ${JSON.stringify({ documentId, opportunityId: document.opportunityId, message: err instanceof Error ? err.message : String(err) })}`,
      );
    });

    return updated;
  } catch {
    // A transient/API failure is retryable by clicking Analyze again --
    // record it as FAILED rather than throwing, so the Server Action
    // completes normally and the UI reflects it via the status chip.
    // instrumentation.ts's onRequestError hook deliberately won't see
    // this: a per-document analysis failure isn't a request-level error.
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
}
