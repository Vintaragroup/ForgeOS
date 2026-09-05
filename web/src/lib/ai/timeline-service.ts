// Maps a scope document's already-extracted keyDates
// (document-summary-service.ts's DocumentSummary.keyDates, captured once
// at Analyze time) onto 9 of the 11 canonical Timeline milestone types --
// every one except the 2 pure rush-fee cutoffs, which stay computed-only
// (see timeline-service.ts's applyRushFeeDefaults).
//
// 4 of these 9 (SHIPPING/INSTALLATION/SHOW_OPEN/DISMANTLE) also have a
// structured Opportunity field (shipDate/targetMoveIn/targetMoveOut/
// eventStartDate) -- timeline-service.ts's regenerateTimeline prefers that
// field when it's set, and only falls back to this AI suggestion when it's
// still empty. An earlier version of this file classified only the other
// 5 types, on the assumption that those 4 would always be known from the
// Opportunity's own onboarding fields -- confirmed wrong live: a real
// document (the client's own project-timeline schedule) stated ship/
// install/show-open/dismantle dates directly, and multi-project
// Opportunities in particular never get those onboarding fields
// auto-filled at all (see opportunity-service.ts's
// applyExtractedFieldsToOpportunity), so Timeline had no way to pick them
// up without this fallback.
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

export type AiEligibleMilestoneType = Exclude<TimelineMilestoneType, "ARTWORK_RUSH_50" | "ARTWORK_RUSH_100">;

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
  // Already resolved once, at Analyze time -- by document-summary-
  // service.ts's text-based pass for a text document, or by
  // drawing-summary-service.ts's vision pass for a DRAWING (which has no
  // extractedText at all -- text-extraction.ts deliberately marks DRAWING
  // UNSUPPORTED for text extraction). resolveTimelineSuggestions below
  // uses this directly for a DRAWING-sourced candidate instead of
  // re-deriving a page number from extractedText, which a DRAWING simply
  // doesn't have.
  pageNumber: number | null;
}

interface RawMilestoneVerdict {
  milestoneType: AiEligibleMilestoneType;
  candidateId: string | null;
}

const MILESTONE_TYPE_DESCRIPTIONS: Record<AiEligibleMilestoneType, string> = {
  SIGNED_PROPOSAL:
    "The date the client is expected to sign/return the proposal to kick off the build. This is usually a target date the estimator sets, not something a document states outright -- null is a common, valid answer.",
  DEPOSIT_DUE: "The date a deposit payment (e.g. a 50% deposit) is due to initiate the build.",
  PRODUCTION_MEETING: "The date of a production/kickoff meeting to finalize build details.",
  ARTWORK_DEADLINE:
    "The date camera-ready/production-ready artwork is due from the client, BEFORE any rush-fee escalation -- not a later rush cutoff date.",
  BALANCE_DUE: "The date the remaining balance payment is due, typically shortly before shipping.",
  SHIPPING: "The date the exhibit/booth materials ship to the show site.",
  INSTALLATION: "The date the booth/exhibit is installed on site (move-in), before the show opens.",
  SHOW_OPEN: "The date the show/event opens to attendees.",
  DISMANTLE: "The date the booth is dismantled/struck (move-out), after the show closes.",
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
              enum: [
                "SIGNED_PROPOSAL",
                "DEPOSIT_DUE",
                "PRODUCTION_MEETING",
                "ARTWORK_DEADLINE",
                "BALANCE_DUE",
                "SHIPPING",
                "INSTALLATION",
                "SHOW_OPEN",
                "DISMANTLE",
              ],
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

// A key date's own label routinely names the milestone outright ("Shipping
// to Show Site", "Installation", "Dismantle", "50% Deposit: Initiates
// Build") -- matching these directly, for free and instantly, is both
// cheaper and more reliable than asking a model to judge something already
// unambiguous in the text. The AI classification pass below only ever runs
// for whatever milestone type this can't confidently resolve, not as a
// first resort. Several patterns exclude another milestone's own keyword
// so a compound label naming two things at once ("Balance Due prior to
// SHIPPING", "Production Ready Artwork Before 50% RUSH Fees Apply") gets
// attributed to the one it's actually ABOUT, not whichever keyword happens
// to appear in it -- confirmed live: SHIPPING without its "balance"/
// "deposit" exclusion matched "Balance Due prior to shipping" and stole
// that row's date.
const CANDIDATE_LABEL_MATCHERS: Partial<Record<AiEligibleMilestoneType, (label: string) => boolean>> = {
  SIGNED_PROPOSAL: (l) => /\bsigned\s+proposal\b/i.test(l),
  DEPOSIT_DUE: (l) => /\bdeposit\b/i.test(l),
  PRODUCTION_MEETING: (l) => /\bproduction\s+meeting\b|\bkick-?off\s+(meeting|call)\b/i.test(l),
  ARTWORK_DEADLINE: (l) => /(production.?ready\s+artwork|artwork\s+deadline)/i.test(l) && !/\brush\b/i.test(l),
  // "balance" alone, not "balance\s+due" -- a real label often punctuates
  // between the two ("BALANCE: Due prior to shipping"), which \s+ can't
  // bridge across the colon. Confirmed live: this exact label silently
  // failed to match under the stricter pattern.
  BALANCE_DUE: (l) => /\bbalance\b|\bfinal\s+payment\b/i.test(l),
  SHIPPING: (l) => /\bshipping\b|\bfreight\b|\bship\s+date\b/i.test(l) && !/\bbalance\b|\bdeposit\b/i.test(l),
  INSTALLATION: (l) => /\binstall(ation)?\b|\bmove-?in\b/i.test(l),
  SHOW_OPEN: (l) => /\bshow\s+open(s|ing)?\b|\bevent\s+open(s|ing)?\b/i.test(l),
  DISMANTLE: (l) => /\bdismantle\b|\bstrike\b|\bmove-?out\b/i.test(l),
};

// Exported for direct testing -- first candidate (in extraction order)
// whose label matches a type's pattern wins; a type with no pattern, or no
// matching candidate, is simply left for the AI pass to attempt instead.
export function matchCandidatesToTypesByLabel(
  candidates: NumberedKeyDateCandidate[],
  types: AiEligibleMilestoneType[],
): Map<AiEligibleMilestoneType, NumberedKeyDateCandidate> {
  const result = new Map<AiEligibleMilestoneType, NumberedKeyDateCandidate>();
  for (const type of types) {
    const matcher = CANDIDATE_LABEL_MATCHERS[type];
    if (!matcher) continue;
    const match = candidates.find((c) => matcher(c.label));
    if (match) result.set(type, match);
  }
  return result;
}

const SYSTEM_PROMPT = `You are a senior event/exhibit-industry estimator building a project timeline from a client's RFP/contract documents. You're given a numbered list of CANDIDATE KEY DATES already extracted from those documents, and a fixed list of MILESTONE TYPES to classify.

For each milestone type, decide which single candidate (if any) states that exact milestone -- e.g. a candidate labeled "50% Deposit Due" or "Initial Payment" matches DEPOSIT_DUE; a candidate labeled "Kickoff Call" or "Production Meeting" matches PRODUCTION_MEETING; a candidate labeled "Move-in" matches INSTALLATION; a candidate labeled "Move-out" or "Strike" matches DISMANTLE. Only match a candidate that clearly and specifically states that milestone -- do not guess, do not match a loosely-related date, and do not invent a date that isn't in the candidate list. If no candidate clearly matches, return null for that type. SIGNED_PROPOSAL in particular is usually not stated in a document at all (it's a target date the estimator sets) -- null is the common, correct answer for it unless a document explicitly states a required signing deadline.

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
    if (!doc) continue;

    // A DRAWING has no extractedText at all (vision-summarized instead of
    // text-extracted -- see NumberedKeyDateCandidate's own comment), so
    // there's no text to re-resolve a quote/page number against. Use the
    // candidate's own already-resolved quote/page directly in that case,
    // same as a text document's candidate did before this fix -- dropping
    // it here (the previous behavior) silently discarded every real
    // DRAWING-sourced date, confirmed live: a real client-supplied
    // schedule image had its Deposit/Artwork/Balance dates come through
    // fine (from a different, text-extractable document) while its own
    // Shipping/Installation/Dismantle dates were silently dropped here.
    let sourceQuote: string;
    let pageNumber: number | null;
    if (doc.extractedText) {
      sourceQuote = resolveHighlightableQuote(doc.extractedText, candidate.sourceQuote);
      const pageTexts = await getPageTextsFor(doc);
      pageNumber = pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null;
    } else {
      sourceQuote = candidate.sourceQuote;
      pageNumber = candidate.pageNumber;
    }

    suggestions.push({
      type: verdict.milestoneType,
      date: parsedDate.toISOString(),
      sourceQuote,
      documentId: doc.id,
      pageNumber,
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
  requestedTypes: AiEligibleMilestoneType[],
): Promise<TimelineMilestoneSuggestion[]> {
  if (requestedTypes.length === 0) return [];

  const scopeDocuments = await getScopeDocuments(opportunityId);
  if (scopeDocuments.length === 0) return [];

  let candidateCounter = 0;
  const candidates: NumberedKeyDateCandidate[] = scopeDocuments.flatMap((d) => {
    const keyDates = (d.extractedSummary as unknown as DocumentSummary | null)?.keyDates ?? [];
    return keyDates.map((kd) => {
      candidateCounter += 1;
      return {
        id: `K${candidateCounter}`,
        filename: d.filename,
        label: kd.label,
        date: kd.date,
        sourceQuote: kd.sourceQuote,
        pageNumber: kd.pageNumber,
      };
    });
  });
  if (candidates.length === 0) return [];

  // Try a direct label match first -- cheap, instant, and more reliable
  // than a model call whenever a key date's own label already names the
  // milestone outright (the common case for a real client-supplied
  // schedule). Only whatever's left over goes to the AI.
  const labelMatches = matchCandidatesToTypesByLabel(candidates, requestedTypes);
  const labelVerdicts: RawMilestoneVerdict[] = [...labelMatches.entries()].map(([milestoneType, candidate]) => ({
    milestoneType,
    candidateId: candidate.id,
  }));
  const remainingTypes = requestedTypes.filter((t) => !labelMatches.has(t));

  let aiVerdicts: RawMilestoneVerdict[] = [];
  if (remainingTypes.length > 0) {
    // Throws AiNotConfiguredError before any call, same posture as
    // clarification-questions-service.ts / proposeLineItemsFromScope.
    const client = getOpenAiClient();

    const milestoneListBlock = remainingTypes.map((t) => `${t}: ${MILESTONE_TYPE_DESCRIPTIONS[t]}`).join("\n");
    const candidateListBlock = candidates
      .map((c) => `${c.id} [${c.filename}]: "${c.label}" -- ${c.date} (quote: "${c.sourceQuote}")`)
      .join("\n");

    const completion = await client.chat.completions.create({
      model: ADVANCED_MODEL,
      // Low, not zero -- structured classification, not creative writing;
      // same rationale and value as clarification-questions-service.ts's
      // own temperature choice.
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
    // Only ever asked about remainingTypes above, but filtered again here
    // regardless -- a model that ignores that scoping shouldn't be able to
    // clobber a label match resolved with certainty a moment ago.
    aiVerdicts = parsed.verdicts.filter((v) => remainingTypes.includes(v.milestoneType));
  }

  return resolveTimelineSuggestions([...labelVerdicts, ...aiVerdicts], candidates, scopeDocuments);
}
