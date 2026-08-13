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
}

export interface RawClarificationQuestion {
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
  "RECOMMENDED: you're confident this is a genuine, specific, professional-grade gap worth sending as-is. WORTH_REVIEWING: a real, plausible gap -- not administrative noise, not something the documents already answer -- but you're not fully certain it rises to the send-as-is bar (e.g. it might be resolved by context you can't see, or its materiality is arguable). Use WORTH_REVIEWING instead of dropping a candidate purely because you're unsure -- the estimator reviewing this has full contract context you don't, and is better positioned to make that final call than a guess in either direction.";

export const CLARIFICATION_SCHEMA = {
  name: "rfp_clarification_questions",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            question: { type: "string", description: QUESTION_DESCRIPTION },
            rationale: { type: "string", description: RATIONALE_DESCRIPTION },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
            documentFilename: {
              type: "string",
              description: "The exact filename (as given in the \"Document:\" header above) this quote came from.",
            },
            confidence: { type: "string", enum: ["RECOMMENDED", "WORTH_REVIEWING"], description: CONFIDENCE_DESCRIPTION },
          },
          required: ["question", "rationale", "sourceQuote", "documentFilename", "confidence"],
        },
      },
    },
    required: ["questions"],
  },
} as const;

// Every sentence here maps to a specific failure mode this feature is
// meant to avoid, not boilerplate: cross-document reading prevents
// restating a fact answered elsewhere; the "any aspect lacking the
// detail needed to price or execute confidently" framing (not a rigid
// enumerated allowlist) is deliberate -- an earlier version restricted
// proposals to four named categories, and a real run against the Super
// Bowl RFP showed that was too narrow: it force-fit a genuine gap
// (who obtains installation/removal permits) into "scope boundary"
// when it's really its own kind of missing-detail question, and would
// have silently excluded other legitimate gaps that don't cleanly fit
// any of the four buckets. The bullets below are illustrative examples
// now, not an exhaustive list -- the real gate is the two hard rules
// (never restate an answered fact, never ask something with no bearing
// on scope/price/execution) plus the explicit "empty list is correct"
// line, which matches Scope Coverage's proven anti-false-alarm framing
// and matters even more here -- a bad question costs a client's
// confidence, a worse outcome than a missed one costs a second look at
// the RFP.
const SYSTEM_PROMPT = `You are a senior, experienced event/exhibit-industry estimator reviewing bidder-question candidates before submitting them to the client. You're given two compact views of the same document set, built by a first-pass reviewer who read each document in full:
1. SCOPE SUMMARY BY DOCUMENT -- a bulleted description of what each document states, with a verbatim quote per bullet. Use this to cross-check facts BETWEEN documents: a genuine contradiction (different numbers, dates, or requirements for the same thing stated in two different documents) is a real gap worth a question even if neither document's own candidate list below flagged it -- the first pass only read one document at a time and couldn't see this, so finding it is now your job, not something to expect pre-flagged.
2. CANDIDATE GAPS BY DOCUMENT -- specific ambiguities the first-pass reviewer already flagged within that ONE document alone (a missing unit, an unresolved responsibility, an internal inconsistency).

Your job is the cross-document judgment neither input alone provides: read everything together, then decide what actually rises to a genuine bidder question -- never restate anything ANY of the documents already answers (a candidate that looked open in one document is often answered, or contradicted, in another), and never ask a generic procurement/administrative question with no bearing on scope, price, or execution.

Propose a question whenever the material above (read together, across all documents) leaves a real, specific detail unresolved that a professional would need pinned down before confidently pricing or executing the work. This covers (not limited to):
- A contradiction between two sections or documents (different numbers, dates, or requirements for the same thing) -- found by comparing the scope summary bullets across documents, not just from a pre-flagged candidate.
- A missing technical parameter, quantity, or specification that materially affects pricing or risk (e.g. "temperature-controlled" with no target range, a load rating with no units, a compliance requirement with no referenced standard/code).
- An unresolved responsibility -- unclear whether the client or the contractor owns a component, a permit, a piece of installation/removal work, or a logistics requirement (disposal, storage, security, etc.).
- A referenced protocol, standard, or exhibit/schedule (named but not itself provided among the documents) whose contents you can't verify.
- A real discrepancy between the drawings/bid set and the written scope of work.
- Any other concrete aspect of the project that lacks the detail needed to bid or execute it with confidence.

Never propose a question about: something already answered anywhere in the provided material, a blank/unfilled field that is clearly resolved only after contract award (e.g. naming a Representative, a Commencement Date triggered by future written notice) rather than during bidding, or a purely administrative/procedural detail with no bearing on scope, price, or execution (submission format, who to contact, deadline logistics). These are not genuine candidates at all -- exclude them regardless of confidence.

For every other real candidate, do NOT silently drop it just because you're unsure it clears the bar -- classify its confidence instead (see the confidence field below) and include it either way. An empty list is still the correct, valuable answer for a well-written RFP with no real candidates at all -- not a failure to find something. A false RECOMMENDED costs a reviewer's confidence in this feature (and, if sent, the client's confidence in the bidder) more than a real gap correctly marked WORTH_REVIEWING costs a moment of the reviewer's time.

For each question:
- question: the exact text to send to the client -- professional, specific, never revealing that an AI wrote it.
- rationale: one sentence, for the estimator's own use only, explaining why this matters.
- sourceQuote: copy the exact quote text given alongside the bullet you're using -- do not alter, shorten, or paraphrase it.
- confidence: RECOMMENDED or WORTH_REVIEWING, per the field description -- don't default to RECOMMENDED just because a candidate was included.
- documentFilename: the exact filename (from the "Document:" header) that bullet came from.`;

// Separated from runClarificationQuestionsAnalysis below so it's directly
// testable without a live OpenAI call -- same reasoning as
// scope-coverage-service.ts's resolveCoverageGaps: drop hallucinated
// filenames, verify quotes against real extracted text, resolve real PDF
// page numbers.
export async function resolveClarificationQuestions(
  rawQuestions: RawClarificationQuestion[],
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
  for (const rawQuestion of rawQuestions) {
    // A filename that doesn't match any document actually sent is a
    // hallucination -- dropped rather than stored as a dangling reference.
    const doc = scopeDocuments.find((d) => d.filename === rawQuestion.documentFilename);
    if (!doc || !doc.extractedText) continue;
    const sourceQuote = resolveHighlightableQuote(doc.extractedText, rawQuestion.sourceQuote);
    const pageTexts = await getPageTextsFor(doc);
    questions.push({
      question: rawQuestion.question,
      rationale: rawQuestion.rationale,
      sourceQuote,
      documentId: doc.id,
      pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
      confidence: rawQuestion.confidence,
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
  // fields). candidateGaps alone can only catch a gap ONE document
  // flagged about itself -- a genuine cross-document contradiction
  // (different numbers/dates for the same requirement in two documents)
  // was never visible to that per-document first pass, so scopeSummary
  // is included too, giving this cross-document reasoning step enough
  // material to actually compare documents against each other, not just
  // curate a pre-flagged list. A document analyzed before these fields
  // existed has none yet; re-analyze it to backfill rather than falling
  // back to raw text here.
  const scopeSummaryBlock = buildBulletsBlock(
    scopeDocuments.map((d) => ({
      filename: d.filename,
      bullets: (d.extractedSummary as unknown as DocumentSummary | null)?.scopeSummary ?? [],
    })),
  );
  const candidateGapsBlock = buildBulletsBlock(
    scopeDocuments.map((d) => ({
      filename: d.filename,
      bullets: (d.extractedSummary as unknown as DocumentSummary | null)?.candidateGaps ?? [],
    })),
  );

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
        content: `SCOPE SUMMARY BY DOCUMENT:\n\n${scopeSummaryBlock}\n\nCANDIDATE GAPS BY DOCUMENT:\n\n${candidateGapsBlock}`,
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
  const parsed = JSON.parse(content) as { questions: RawClarificationQuestion[] };
  const questions = await resolveClarificationQuestions(parsed.questions, scopeDocuments);

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
