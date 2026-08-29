// Companion to document-summary-service.ts for MEETING_NOTES documents --
// same text-extraction pipeline (a transcript is plain text/PDF/DOCX,
// nothing special there), but a genuinely different system prompt. A
// meeting transcript isn't a formal deliverable like an RFP: it mixes
// real, price-relevant scope discussion with things that read like scope
// but aren't -- a different client's project mentioned only in passing,
// or (a real, confirmed case) the team discussing the estimating
// platform itself rather than the job being estimated. A generic
// summarizer would happily extract both as if they were real scope;
// this prompt exists specifically to not do that.
//
// Reuses document-summary-service.ts's DocumentSummary/CitedText/
// KeyDateFact shapes one-directionally, same pattern drawing-summary-
// service.ts already uses -- ProjectBriefCard (opportunities/[id]/
// page.tsx) needs zero changes to render any of the three extraction
// paths. extractedFields/suggestedDocumentType are deliberately not
// populated here (same "optional, this path doesn't produce it" posture
// drawing-summary-service.ts already has for suggestedDocumentType) --
// a transcript is rarely the authoritative source for a booth number or
// ship date, and it's already correctly typed, so there's nothing to
// suggest retagging it as.

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
import type { DocumentSummary, KeyDateType } from "@/lib/ai/document-summary-service";

type MeetingNotesFromAI = {
  eventOrProjectName: string | null;
  venue: string | null;
  submissionDeadline: string | null;
  keyDates: { label: string; date: string; dateType: KeyDateType; sourceQuote: string; project?: string }[];
  scopeSummary: { text: string; sourceQuote: string; project?: string }[];
  riskFlags: { text: string; sourceQuote: string; project?: string }[];
  candidateGaps: { text: string; sourceQuote: string; project?: string }[];
};

const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from the transcript above, showing where this was said. Never paraphrase.";

// Same withProjectField composition pattern as document-summary-
// service.ts's buildSummarySchema -- projectNames.length === 0 (the
// common single-project case) returns the item schema unchanged, no
// extra token cost.
function withProjectField<
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

function buildMeetingNotesSchema(projectNames: string[]) {
  return {
    name: "meeting_notes_summary",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        eventOrProjectName: { type: ["string", "null"] },
        venue: { type: ["string", "null"] },
        submissionDeadline: { type: ["string", "null"], description: "Free-text date, as written in the transcript." },
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
                      "From the READER's (contractor's) point of view. DEADLINE: the reader must submit/deliver/act by this date. MILESTONE: a fixed point worth planning around, nothing due from the reader that day. INFORMATIONAL: a fact about something the client or another party already did.",
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
                  text: {
                    type: "string",
                    description: "A specific, price-relevant scope fact actually discussed -- a component, dimension, material, quantity, or design decision. Not a paraphrase of the whole meeting.",
                  },
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
                  text: { type: "string", description: "A cost, schedule, engineering, or approval risk raised in discussion -- something needing sign-off, an unresolved responsibility, a subcontracting/sourcing dependency." },
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
                      "An open item, unresolved question, or unconfirmed spec raised in the meeting that blocks a confident estimate -- e.g. an unconfirmed budget, an undecided fabrication method, a spec still pending a vendor quote or client answer. An action item ('X will get a quote for Y') maps directly onto this -- the underlying thing is still unresolved.",
                  },
                  sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
                },
                required: ["text", "sourceQuote"],
              },
              projectNames,
            ),
          },
        },
      },
      required: ["eventOrProjectName", "venue", "submissionDeadline", "keyDates", "scopeSummary", "riskFlags", "candidateGaps"],
    },
  };
}

function buildSystemPrompt(projectNames: string[]): string {
  const base = `You read meeting transcripts, recaps, and email threads for a contractor whose work spans tradeshow exhibits, standalone events, and specialized/experiential builds. Extract only what's actually said or written -- never infer or guess a fact that isn't stated. Keep scopeSummary/riskFlags/candidateGaps as short, specific bullet points, not paragraphs. For every item, include sourceQuote: a short verbatim quote showing where it came from.

Two things you must actively exclude, not just deprioritize -- do not extract either as scope, a risk, or a gap, even in passing:
1. Discussion about the estimating software, AI tooling, or platform/process development itself -- e.g. a team discussing how their own estimating system works, its roadmap, data ingestion, or user interface. That is a conversation ABOUT the tool being used to do the work, not about the job being estimated.
2. A different client's project or show mentioned only in passing, unrelated to the actual scope being discussed (e.g. a name-check of another account the team also works on). Only extract facts about the actual project(s) this transcript is really about.

When genuinely uncertain whether something belongs to the real project scope or is one of the two exclusions above, lean toward excluding it -- a missed real fact costs a second read of the transcript; a platform/off-topic fact extracted as if it were scope actively corrupts the estimate.

Also extract candidateGaps: unresolved open items raised in discussion that block a confident estimate -- an unconfirmed budget, an undecided method, a spec still pending a quote or client answer. An action item assigning someone to go get information maps directly onto this: the underlying fact is still unresolved right now, which is what matters for pricing.`;

  if (projectNames.length === 0) return base;

  return (
    base +
    `\n\nThis transcript may discuss multiple separate projects: ${projectNames.map((n) => `"${n}"`).join(", ")}. For every key date, scope item, risk flag, and candidate gap, classify which one it belongs to using the project field -- respond with the exact project name, or "SHARED" only if it genuinely applies to more than one (e.g. a general relationship/billing fact). A transcript naturally jumps between topics -- read the surrounding context (who's speaking, what was just discussed) to attribute each fact correctly rather than defaulting to whichever project was mentioned most recently.`
  );
}

export async function summarizeMeetingNotes(documentId: string, userId: string | null = null) {
  let loaded: { document: Awaited<ReturnType<typeof getDocumentBytes>>["document"]; bytes: Buffer; extraction: ExtractionResult };
  try {
    const { document, bytes } = await getDocumentBytes(documentId);
    const extraction = await extractDocumentText(document.documentType, document.mimeType, bytes, document.filename);
    loaded = { document, bytes, extraction };
  } catch {
    // Same retry posture as the OpenAI-call catch below -- see
    // document-summary-service.ts's identical guard for the full
    // rationale (a stale storage reference used to crash the whole
    // Server Action instead of landing here).
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
  const { document, bytes, extraction } = loaded;

  if (extraction.status === "UNSUPPORTED") {
    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "UNSUPPORTED", extractedText: null },
    });
  }

  // Checked before any DB write, same posture as summarizeDocument -- a
  // missing key leaves the document PENDING/retryable, not stuck.
  const client = getOpenAiClient();

  const MAX_INPUT_CHARS = 150_000;
  await db.document.update({
    where: { id: documentId },
    data: { extractionStatus: "PROCESSING", extractedText: extraction.text.slice(0, MAX_INPUT_CHARS) },
  });

  const projectContext = document.estimateId ? { estimates: [] } : await getProjectContext(document.opportunityId);
  const projectNames = projectContext.estimates.map((e) => e.name);
  // Correctly attributing which of two real projects a given sentence of
  // a transcript belongs to is a genuine judgment call (reading
  // surrounding context, not just keyword matching) -- confirmed by a
  // real test: BASIC_MODEL misattributed unambiguous PGA-only content
  // (a golf-ball sculpture) to a Baseball project's bucket, and one
  // document's PGA section was dropped from extraction entirely. That's
  // the same class of task Scope Coverage/Clarification Questions
  // reserve ADVANCED_MODEL for -- cross-topic reasoning, not
  // straightforward single-pass extraction -- so multi-project
  // classification gets it too. Single-project extraction (the common
  // case, projectNames empty) stays on BASIC_MODEL; there's nothing to
  // misclassify when there's only one project.
  const model = projectNames.length > 0 ? ADVANCED_MODEL : BASIC_MODEL;

  try {
    const completion = await client.chat.completions.create({
      model,
      // Low, not zero -- exhaustive extraction with an accuracy-critical
      // exclusion rule, not creative writing. See document-summary-
      // service.ts's own comment for the measured run-to-run variance
      // this addresses.
      temperature: 0.2,
      messages: [
        { role: "system", content: buildSystemPrompt(projectNames) },
        { role: "user", content: `Transcript: ${document.filename}\n\n${extraction.text.slice(0, MAX_INPUT_CHARS)}` },
      ],
      response_format: { type: "json_schema", json_schema: buildMeetingNotesSchema(projectNames) },
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
    const parsed = JSON.parse(content) as MeetingNotesFromAI;

    const pageTexts = document.mimeType === PDF_MIME ? await extractPdfPageTexts(bytes) : null;

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
    };

    return db.document.update({
      where: { id: documentId },
      data: { extractionStatus: "COMPLETE", extractedSummary: summary as unknown as Prisma.InputJsonObject },
    });
  } catch {
    // Same retryable-FAILED posture as summarizeDocument's catch-all.
    return db.document.update({ where: { id: documentId }, data: { extractionStatus: "FAILED" } });
  }
}
