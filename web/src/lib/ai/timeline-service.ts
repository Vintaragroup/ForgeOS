// Maps a scope document's already-extracted keyDates
// (document-summary-service.ts's DocumentSummary.keyDates, captured once
// at Analyze time) onto the 5 canonical Timeline milestone types that have
// no structured Opportunity field to source from (see timeline-service.ts's
// DETERMINISTIC_FIELD_BY_TYPE for the other 4, and its rush-fee offsets for
// the remaining 2).
//
// Follows clarification-questions-service.ts's proven checklist pattern
// rather than a free-form "populate a timeline" prompt: that file's own
// history shows a free-form version silently under-reported real
// candidates despite an explicit instruction not to. Forcing one verdict
// per fixed milestone type turns "did the model even consider this type"
// from invisible to directly checkable.

import type { TimelineMilestoneType } from "@/generated/prisma/enums";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { getScopeDocuments } from "@/lib/ai/scope-document-context";
import { getDocumentBytes } from "@/lib/document-service";
import { extractPdfPageTexts, locateQuotePage, resolveHighlightableQuote, PDF_MIME } from "@/lib/ai/text-extraction";
import { parseFreeTextDate } from "@/lib/citation";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";

export type NonDeterministicMilestoneType = Extract<
  TimelineMilestoneType,
  "SIGNED_PROPOSAL" | "DEPOSIT_DUE" | "PRODUCTION_MEETING" | "ARTWORK_DEADLINE" | "BALANCE_DUE"
>;

export interface TimelineMilestoneSuggestion {
  type: TimelineMilestoneType;
  date: string;
  sourceQuote: string;
  documentId: string;
  pageNumber: number | null;
}

interface NumberedKeyDateCandidate {
  id: string;
  filename: string;
  label: string;
  date: string;
  sourceQuote: string;
}

interface RawMilestoneVerdict {
  milestoneType: NonDeterministicMilestoneType;
  candidateId: string | null;
}

const MILESTONE_TYPE_DESCRIPTIONS: Record<NonDeterministicMilestoneType, string> = {
  SIGNED_PROPOSAL:
    "The date the client is expected to sign/return the proposal to kick off the build. This is usually a target date the estimator sets, not something a document states outright -- null is a common, valid answer.",
  DEPOSIT_DUE: "The date a deposit payment (e.g. a 50% deposit) is due to initiate the build.",
  PRODUCTION_MEETING: "The date of a production/kickoff meeting to finalize build details.",
  ARTWORK_DEADLINE:
    "The date camera-ready/production-ready artwork is due from the client, BEFORE any rush-fee escalation -- not a later rush cutoff date.",
  BALANCE_DUE: "The date the remaining balance payment is due, typically shortly before shipping.",
};

export const TIMELINE_SCHEMA = {
  name: "timeline_milestone_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdicts: {
        type: "array",
        description:
          "Exactly one entry for EVERY milestone type listed below, in the order given -- none skipped, none merged.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            milestoneType: {
              type: "string",
              enum: ["SIGNED_PROPOSAL", "DEPOSIT_DUE", "PRODUCTION_MEETING", "ARTWORK_DEADLINE", "BALANCE_DUE"],
            },
            candidateId: {
              type: ["string", "null"],
              description:
                "The exact K-id of the candidate key date that states this milestone, or null if none of the candidates clearly state it. Never invent a date that isn't one of the given candidates.",
            },
          },
          required: ["milestoneType", "candidateId"],
        },
      },
    },
    required: ["verdicts"],
  },
} as const;

const SYSTEM_PROMPT = `You are a senior event/exhibit-industry estimator building a project timeline from a client's RFP/contract documents. You're given a numbered list of CANDIDATE KEY DATES already extracted from those documents, and a fixed list of MILESTONE TYPES to classify.

For each milestone type, decide which single candidate (if any) states that exact milestone -- e.g. a candidate labeled "50% Deposit Due" or "Initial Payment" matches DEPOSIT_DUE; a candidate labeled "Kickoff Call" or "Production Meeting" matches PRODUCTION_MEETING. Only match a candidate that clearly and specifically states that milestone -- do not guess, do not match a loosely-related date, and do not invent a date that isn't in the candidate list. If no candidate clearly matches, return null for that type. SIGNED_PROPOSAL in particular is usually not stated in a document at all (it's a target date the estimator sets) -- null is the common, correct answer for it unless a document explicitly states a required signing deadline.

You must return exactly one entry per milestone type listed, in order -- this is a checklist you complete in full, not a shortlist you selectively pull from.`;

// Separated from runTimelineExtraction so it's directly testable without a
// live OpenAI call -- same reasoning as clarification-questions-service.ts's
// resolveClarificationQuestions: drop hallucinated candidate ids, verify
// quotes against real extracted text, resolve real PDF page numbers.
export async function resolveTimelineSuggestions(
  verdicts: RawMilestoneVerdict[],
  candidates: NumberedKeyDateCandidate[],
  scopeDocuments: { id: string; filename: string; extractedText: string | null; mimeType: string }[],
): Promise<TimelineMilestoneSuggestion[]> {
  const pageTextsByDocument = new Map<string, string[] | null>();
  async function getPageTextsFor(doc: (typeof scopeDocuments)[number]): Promise<string[] | null> {
    if (doc.mimeType !== PDF_MIME) return null;
    if (pageTextsByDocument.has(doc.id)) return pageTextsByDocument.get(doc.id)!;
    const { bytes } = await getDocumentBytes(doc.id);
    const pageTexts = await extractPdfPageTexts(bytes);
    pageTextsByDocument.set(doc.id, pageTexts);
    return pageTexts;
  }

  const suggestions: TimelineMilestoneSuggestion[] = [];
  for (const verdict of verdicts) {
    if (!verdict.candidateId) continue;
    const candidate = candidates.find((c) => c.id === verdict.candidateId);
    if (!candidate) continue; // hallucinated id -- dropped, not stored as a dangling reference
    const parsedDate = parseFreeTextDate(candidate.date);
    if (!parsedDate) continue; // can't use a date we can't parse

    const doc = scopeDocuments.find((d) => d.filename === candidate.filename);
    if (!doc || !doc.extractedText) continue;

    const sourceQuote = resolveHighlightableQuote(doc.extractedText, candidate.sourceQuote);
    const pageTexts = await getPageTextsFor(doc);
    suggestions.push({
      type: verdict.milestoneType,
      date: parsedDate.toISOString(),
      sourceQuote,
      documentId: doc.id,
      pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
    });
  }
  return suggestions;
}

// Cheap by construction, same as clarification-questions-service.ts: no
// live OpenAI call at all when there's nothing to classify -- an
// opportunity with no scope documents yet (or none with any key dates)
// simply gets no AI suggestions, and timeline-service.ts's deterministic +
// rush-fee-default milestones still populate normally.
export async function runTimelineExtraction(
  opportunityId: string,
  userId: string | null,
  requestedTypes: NonDeterministicMilestoneType[],
): Promise<TimelineMilestoneSuggestion[]> {
  if (requestedTypes.length === 0) return [];

  const scopeDocuments = await getScopeDocuments(opportunityId);
  if (scopeDocuments.length === 0) return [];

  let candidateCounter = 0;
  const candidates: NumberedKeyDateCandidate[] = scopeDocuments.flatMap((d) => {
    const keyDates = (d.extractedSummary as unknown as DocumentSummary | null)?.keyDates ?? [];
    return keyDates.map((kd) => {
      candidateCounter += 1;
      return { id: `K${candidateCounter}`, filename: d.filename, label: kd.label, date: kd.date, sourceQuote: kd.sourceQuote };
    });
  });
  if (candidates.length === 0) return [];

  // Throws AiNotConfiguredError before any call, same posture as
  // clarification-questions-service.ts / proposeLineItemsFromScope.
  const client = getOpenAiClient();

  const milestoneListBlock = requestedTypes.map((t) => `${t}: ${MILESTONE_TYPE_DESCRIPTIONS[t]}`).join("\n");
  const candidateListBlock = candidates
    .map((c) => `${c.id} [${c.filename}]: "${c.label}" -- ${c.date} (quote: "${c.sourceQuote}")`)
    .join("\n");

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    // Low, not zero -- structured classification, not creative writing;
    // same rationale and value as clarification-questions-service.ts's own
    // temperature choice.
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `MILESTONE TYPES TO CLASSIFY -- exactly one verdict per type:\n\n${milestoneListBlock}\n\nCANDIDATE KEY DATES:\n\n${candidateListBlock}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: TIMELINE_SCHEMA },
  });

  await recordAiUsage({
    userId,
    feature: "TIMELINE_MILESTONES",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { verdicts: RawMilestoneVerdict[] };

  return resolveTimelineSuggestions(parsed.verdicts, candidates, scopeDocuments);
}
