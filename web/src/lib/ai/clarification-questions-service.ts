// Reviews an opportunity's RFP/scope-of-work documents and proposes
// professional-grade clarification questions to send back to the client
// before the bidder-questions deadline -- distinct from
// scope-coverage-service.ts, which checks whether the ESTIMATE covers the
// RFP's scope. This checks the RFP itself for genuine ambiguity, before
// any pricing happens. Read-only, advisory -- never sends anything,
// never blocks anything.
//
// The real product here is the system prompt's quality bar, not the
// plumbing: a tool that surfaces questions a novice would ask (things
// already answered in the documents, generic submission-process
// questions) actively costs a reviewer's confidence, worse than Scope
// Coverage's own false-alarm risk -- see SYSTEM_PROMPT below.

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { extractPdfPageTexts, locateQuotePage, resolveHighlightableQuote, PDF_MIME } from "@/lib/ai/text-extraction";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { getDocumentBytes } from "@/lib/document-service";
import { getScopeDocuments, buildBulletsBlock } from "@/lib/ai/scope-document-context";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";

// Two tiers, not a binary include/exclude -- a real audit of this
// feature's own output found that roughly half of what a single AI pass
// silently dropped (contract-term blanks, an undefined referenced
// protocol) was genuinely ambiguous even to a careful human read, not
// clearly noise. Forcing one model call to make that binary call
// unsupervised was the actual bug; surfacing the uncertain middle for a
// human with real contract context to judge is more reliable than
// tuning the prompt further to guess where the line is.
export type ClarificationConfidence = "RECOMMENDED" | "WORTH_REVIEWING";

export interface ClarificationQuestion {
  // Exact client-ready text -- phrased to send as-is, never revealing an
  // AI wrote it.
  question: string;
  // One sentence, for the estimator's own judgment call on whether to
  // actually send it -- never shown to the client.
  rationale: string;
  // Verbatim quote from the source document, verified against its
  // extractedText -- resolveHighlightableQuote below, same discipline as
  // scope-coverage-service.ts / document-summary-service.ts.
  sourceQuote: string;
  documentId: string;
  // Named to match citationHref's `fact` param directly (see citation.ts).
  pageNumber: number | null;
  confidence: ClarificationConfidence;
  // Inherited directly from the candidate's already-resolved tag (see
  // document-summary-service.ts) -- no new classification happens at
  // this stage, since the candidate was already tagged once at Analyze
  // time. null for a question sourced from additionalFindings (a
  // genuinely new cross-document contradiction, not pre-tagged) --
  // shown as shared/unclassified rather than guessed.
  estimateId: string | null;
}

// One numbered reference per document's candidateGaps entry, built
// server-side -- filename/text/quote all came from document-summary-
// service.ts's own verified extraction, not from this call. The model
// classifies these BY ID rather than re-stating them from scratch (see
// CandidateVerdict below). This closes a real, confirmed loophole: an
// earlier version just asked the model to "propose questions" from a
// bulleted list and tag confidence on whatever it chose to mention --
// in practice, across repeated live runs, it never once used
// WORTH_REVIEWING and simply omitted roughly 70% of real candidates
// instead of tagging them uncertain, despite an explicit instruction not
// to. A soft "don't drop things" instruction wasn't reliable; requiring
// one verdict per numbered id turns "did you consider this candidate at
// all" from invisible to directly checkable.
interface NumberedCandidate {
  id: string;
  filename: string;
  text: string;
  sourceQuote: string;
  // Already resolved once, at Analyze time (document-summary-service.ts)
  // -- carried through here, not re-classified. No new AI call needed to
  // know which project a candidate belongs to.
  estimateId: string | null;
}

interface RawCandidateVerdict {
  candidateId: string;
  verdict: "EXCLUDE" | "RECOMMENDED" | "WORTH_REVIEWING";
  question: string | null;
  rationale: string | null;
}

// Distinct from a numbered candidate -- a genuinely NEW gap the model
// finds only by comparing scope summary bullets across documents (e.g.
// a contradiction), so it can't be pre-enumerated the way candidateGaps
// can. Freeform, same shape the whole schema used before this rewrite.
export interface RawClarificationFinding {
  question: string;
  rationale: string;
  sourceQuote: string;
  documentFilename: string;
  confidence: ClarificationConfidence;
}

const QUESTION_DESCRIPTION =
  "The exact question text to send to the client, professional and specific -- phrased as you would actually send it, never revealing that an AI wrote it.";
const RATIONALE_DESCRIPTION =
  "One sentence, for the estimator's own internal use only (never sent to the client), explaining why this gap or ambiguity matters.";
const SOURCE_QUOTE_DESCRIPTION =
  "Copy the quote text given alongside the candidate you're using, EXACTLY as given. Never paraphrase, shorten, or summarize it.";
const CONFIDENCE_DESCRIPTION =
  "RECOMMENDED: you're confident this is a genuine, specific, professional-grade gap worth sending as-is. WORTH_REVIEWING: a real, plausible gap -- not administrative noise, not something the documents already answer -- but you're not fully certain it rises to the send-as-is bar. Use WORTH_REVIEWING instead of EXCLUDE whenever you're genuinely unsure, not just when confident.";
const VERDICT_DESCRIPTION =
  "EXCLUDE: not a genuine bidder question at all -- already answered elsewhere, a contract field resolved only after award (e.g. naming a Representative), or purely administrative/procedural. RECOMMENDED is the DEFAULT for any candidate that clears EXCLUDE -- a real, specific, professional-grade gap (a missing unit, an unnamed responsibility, an undefined referenced protocol) is RECOMMENDED even if you can't be 100% certain it matters, because a seasoned estimator would confidently send it as-is; e.g. 'no target temperature range given for a temperature-controlled requirement' is RECOMMENDED, not WORTH_REVIEWING -- that's a concrete, senior-level catch, not a maybe. Reserve WORTH_REVIEWING for a candidate with a SPECIFIC, nameable reason for hesitation beyond general caution -- e.g. its materiality is genuinely debatable, or it plausibly duplicates another candidate, or it might be resolved by an exhibit/schedule you weren't given. Do not use WORTH_REVIEWING as a hedge for every candidate you're reviewing rather than proposing yourself -- most real candidates that survive EXCLUDE should land on RECOMMENDED.";

export const CLARIFICATION_SCHEMA = {
  name: "rfp_clarification_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      candidateReview: {
        type: "array",
        description:
          "Exactly one entry for EVERY candidate id listed below (G1, G2, G3, ...) -- every single one, in order, none skipped or merged. This is a checklist, not a proposal list: you are reviewing what's already been flagged, not selectively choosing which ones to mention.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            candidateId: { type: "string", description: "The exact G-id (e.g. \"G4\") from the candidate list below this entry classifies." },
            verdict: { type: "string", enum: ["EXCLUDE", "RECOMMENDED", "WORTH_REVIEWING"], description: VERDICT_DESCRIPTION },
            question: { type: ["string", "null"], description: "The exact client-ready question text, rewritten from the candidate's raw description -- required (non-null) unless verdict is EXCLUDE, in which case null." },
            rationale: { type: ["string", "null"], description: RATIONALE_DESCRIPTION + " Required (non-null) unless verdict is EXCLUDE, in which case null." },
          },
          required: ["candidateId", "verdict", "question", "rationale"],
        },
      },
      additionalFindings: {
        type: "array",
        description:
          "Genuinely NEW gaps found only by comparing the scope summary bullets ACROSS documents (e.g. a contradiction between two documents) that aren't already one of the numbered candidates above. Usually empty -- most real gaps are already in the candidate list, so don't restate one here.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string", description: QUESTION_DESCRIPTION },
            rationale: { type: "string", description: RATIONALE_DESCRIPTION },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
            documentFilename: {
              type: "string",
              description: "The exact filename (as given in the \"Document:\" header) this quote came from.",
            },
            confidence: { type: "string", enum: ["RECOMMENDED", "WORTH_REVIEWING"], description: CONFIDENCE_DESCRIPTION },
          },
          required: ["question", "rationale", "sourceQuote", "documentFilename", "confidence"],
        },
      },
    },
    required: ["candidateReview", "additionalFindings"],
  },
} as const;

// Every sentence here maps to a specific failure mode this feature is
// meant to avoid, not boilerplate: cross-document reading prevents
// restating a fact answered elsewhere; the "any aspect lacking the
// detail needed to price or execute confidently" framing (not a rigid
// enumerated allowlist) is deliberate -- an earlier version restricted
// proposals to four named categories, and a real run against the Super
// Bowl RFP showed that was too narrow. The candidateReview checklist
// structure is a second, later fix for a second failure mode: a
// free-form "propose questions, tag confidence" version was measured
// (across repeated live runs against this same RFP) to never use
// WORTH_REVIEWING at all and simply omit most real candidates instead --
// see candidateReview's own schema comment.
const SYSTEM_PROMPT = `You are a senior, experienced event/exhibit-industry estimator reviewing bidder-question candidates before submitting them to the client. You're given:
1. SCOPE SUMMARY BY DOCUMENT -- a bulleted description of what each document states, with a verbatim quote per bullet, for spotting NEW contradictions ACROSS documents (different numbers, dates, or requirements for the same thing stated in two different documents). Report a contradiction you find here as an entry in additionalFindings, not candidateReview -- it isn't one of the numbered candidates.
2. A numbered CANDIDATE GAPS list (G1, G2, ...) -- specific ambiguities a first-pass reviewer already flagged within one document. You must review and classify EVERY single one of these by id in candidateReview -- this is a checklist you complete in full, not a shortlist you selectively pull from. Skipping, merging, or silently ignoring a candidate is treated the same as answering it wrong.

For each candidate, decide a verdict:
- EXCLUDE: only when you're confident it is NOT a genuine bidder question -- already answered elsewhere (including by another document), a contract field resolved only after award (e.g. naming a Representative, a Commencement Date triggered by future written notice), or purely administrative/procedural (submission format, who to contact, deadline logistics).
- RECOMMENDED is the DEFAULT for anything that clears EXCLUDE: a real, specific gap (a missing unit, an unnamed responsibility, an undefined referenced protocol) is RECOMMENDED even without 100% certainty it matters, because a seasoned estimator would confidently send it as-is. "No target temperature range given for a temperature-controlled requirement" is RECOMMENDED, not a maybe.
- WORTH_REVIEWING is reserved for a candidate with a SPECIFIC, nameable reason for hesitation -- its materiality is genuinely debatable, it plausibly duplicates another candidate, or it might be resolved by an exhibit/schedule you weren't given. It is not a general hedge for "I'm reviewing this, not proposing it myself" -- most real candidates should land on RECOMMENDED.

For every candidate that isn't EXCLUDE, write the actual client-facing question: professional, specific, never revealing that an AI wrote it -- rewritten from the candidate's raw internal description, not copied verbatim. An empty candidateReview would mean you skipped candidates, which is not allowed; an all-EXCLUDE result is a valid outcome only for a genuinely well-written RFP with no real gaps at all -- not a default to reach for when unsure.

For additionalFindings (new cross-document contradictions only, not restatements of a numbered candidate): same question/rationale quality bar, plus sourceQuote (copy the exact quote text given for that scope summary bullet) and documentFilename (the exact filename from its "Document:" header). Leave this empty unless you found something genuinely new that comparing documents revealed.`;

// Separated from runClarificationQuestionsAnalysis below so it's directly
// testable without a live OpenAI call -- same reasoning as
// scope-coverage-service.ts's resolveCoverageGaps: drop hallucinated
// references, verify quotes against real extracted text, resolve real
// PDF page numbers.
export async function resolveClarificationQuestions(
  candidateReview: RawCandidateVerdict[],
  candidates: NumberedCandidate[],
  additionalFindings: RawClarificationFinding[],
  scopeDocuments: { id: string; filename: string; extractedText: string | null; mimeType: string }[],
): Promise<ClarificationQuestion[]> {
  const pageTextsByDocument = new Map<string, string[] | null>();
  async function getPageTextsFor(doc: (typeof scopeDocuments)[number]): Promise<string[] | null> {
    if (doc.mimeType !== PDF_MIME) return null;
    if (pageTextsByDocument.has(doc.id)) return pageTextsByDocument.get(doc.id)!;
    const { bytes } = await getDocumentBytes(doc.id);
    const pageTexts = await extractPdfPageTexts(bytes);
    pageTextsByDocument.set(doc.id, pageTexts);
    return pageTexts;
  }

  const questions: ClarificationQuestion[] = [];

  for (const entry of candidateReview) {
    if (entry.verdict === "EXCLUDE") continue;
    if (!entry.question || !entry.rationale) continue;
    // An id that doesn't match a real candidate is a hallucination --
    // dropped rather than stored as a dangling reference.
    const candidate = candidates.find((c) => c.id === entry.candidateId);
    if (!candidate) continue;
    const doc = scopeDocuments.find((d) => d.filename === candidate.filename);
    if (!doc || !doc.extractedText) continue;
    // The quote is server-truth (candidate.sourceQuote came from
    // document-summary-service.ts's own already-verified extraction, not
    // from this call) -- re-resolved here only because
    // resolveHighlightableQuote's fuzzy-match convention is what the PDF
    // highlight viewer expects.
    const sourceQuote = resolveHighlightableQuote(doc.extractedText, candidate.sourceQuote);
    const pageTexts = await getPageTextsFor(doc);
    questions.push({
      question: entry.question,
      rationale: entry.rationale,
      sourceQuote,
      documentId: doc.id,
      pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
      confidence: entry.verdict,
      estimateId: candidate.estimateId,
    });
  }

  for (const finding of additionalFindings) {
    const doc = scopeDocuments.find((d) => d.filename === finding.documentFilename);
    if (!doc || !doc.extractedText) continue;
    const sourceQuote = resolveHighlightableQuote(doc.extractedText, finding.sourceQuote);
    const pageTexts = await getPageTextsFor(doc);
    questions.push({
      question: finding.question,
      rationale: finding.rationale,
      sourceQuote,
      documentId: doc.id,
      pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
      confidence: finding.confidence,
      // additionalFindings are genuinely new cross-document
      // contradictions discovered at THIS stage, not pre-tagged like a
      // numbered candidate -- shown as shared/unclassified rather than
      // guessed. A real gap in coverage if this path fires often; it's
      // documented as "usually empty" by design (see SYSTEM_PROMPT),
      // so left unresolved for now rather than adding a second
      // classification pass for a rare case.
      estimateId: null,
    });
  }

  return questions;
}

export async function runClarificationQuestionsAnalysis(opportunityId: string, userId: string | null = null) {
  const scopeDocuments = await getScopeDocuments(opportunityId);
  if (scopeDocuments.length === 0) {
    throw new Error("No analyzed scope documents yet -- click Analyze on a document from the Opportunity page first.");
  }

  // Throws AiNotConfiguredError before any DB write, same posture as
  // proposeLineItemsFromScope / runScopeCoverageAnalysis.
  const client = getOpenAiClient();

  // Compact bullets, not raw text -- both were extracted by
  // document-summary-service.ts's cheap model reading each document's
  // FULL text at Analyze time (see its own scopeSummary/candidateGaps
  // fields). scopeSummary is for spotting NEW cross-document
  // contradictions (see additionalFindings); candidateGaps below is
  // numbered into a checklist the model must fully account for.
  const scopeSummaryBlock = buildBulletsBlock(
    scopeDocuments.map((d) => ({
      filename: d.filename,
      bullets: (d.extractedSummary as unknown as DocumentSummary | null)?.scopeSummary ?? [],
    })),
  );

  let candidateCounter = 0;
  const candidates: NumberedCandidate[] = scopeDocuments.flatMap((d) => {
    const gaps = (d.extractedSummary as unknown as DocumentSummary | null)?.candidateGaps ?? [];
    return gaps.map((g) => {
      candidateCounter += 1;
      return {
        id: `G${candidateCounter}`,
        filename: d.filename,
        text: g.text,
        sourceQuote: g.sourceQuote,
        estimateId: g.estimateId ?? null,
      };
    });
  });
  const candidateListBlock =
    candidates.length > 0
      ? candidates.map((c) => `${c.id} [${c.filename}]: ${c.text} (quote: "${c.sourceQuote}")`).join("\n")
      : "(none -- every analyzed document had no candidate gaps; re-analyze if this seems wrong)";

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    // Low, not zero -- this is a structured-extraction/judgment task, not
    // creative writing, so there's no upside to the API default's high
    // randomness here. Confirmed the variance was real: three identical
    // re-runs against the same real RFP produced 5, then 4, then 3
    // questions with no input change. A low temperature won't make every
    // run identical, but cuts the sampling noise that was doing that.
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `SCOPE SUMMARY BY DOCUMENT:\n\n${scopeSummaryBlock}\n\nCANDIDATE GAPS -- classify EVERY one of these by id in candidateReview:\n\n${candidateListBlock}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: CLARIFICATION_SCHEMA },
  });

  await recordAiUsage({
    userId,
    feature: "RFP_CLARIFICATION_QUESTIONS",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as {
    candidateReview: RawCandidateVerdict[];
    additionalFindings: RawClarificationFinding[];
  };
  // Observable now, where it was invisible before: if the model didn't
  // actually cover every candidate despite the instruction, this is the
  // one place that fact could still go unnoticed -- logged rather than
  // silently accepted, since diagnosing the previous silent-drop bug
  // required pulling raw data directly from the database.
  if (parsed.candidateReview.length < candidates.length) {
    console.warn(
      `runClarificationQuestionsAnalysis: model reviewed ${parsed.candidateReview.length}/${candidates.length} candidates for opportunity ${opportunityId}`,
    );
  }
  const questions = await resolveClarificationQuestions(
    parsed.candidateReview,
    candidates,
    parsed.additionalFindings,
    scopeDocuments,
  );

  return db.opportunity.update({
    where: { id: opportunityId },
    data: {
      clarificationQuestions: {
        generatedAt: new Date().toISOString(),
        questions,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}
