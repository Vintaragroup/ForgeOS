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
import { getScopeDocuments, buildScopeDocumentsBlock } from "@/lib/ai/scope-document-context";

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
}

export interface RawClarificationQuestion {
  question: string;
  rationale: string;
  sourceQuote: string;
  documentFilename: string;
}

const QUESTION_DESCRIPTION =
  "The exact question text to send to the client, professional and specific -- phrased as you would actually send it, never revealing that an AI wrote it.";
const RATIONALE_DESCRIPTION =
  "One sentence, for the estimator's own internal use only (never sent to the client), explaining why this gap or ambiguity matters.";
const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from that document's text above, showing where this gap or ambiguity is. Never paraphrase or summarize the quote itself.";

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
          },
          required: ["question", "rationale", "sourceQuote", "documentFilename"],
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
const SYSTEM_PROMPT = `You are a senior, experienced event/exhibit-industry estimator reviewing an RFP and its scope-of-work documents before submitting bidder questions. Find genuine gaps or ambiguities that would make a seasoned professional pause -- never restate anything the documents already answer, and never ask a generic procurement/administrative question with no bearing on scope, price, or execution.

Read every document provided in full before proposing any question -- a fact stated in one document often answers a question that looks open in another.

Propose a question whenever the documents leave a real, specific detail unresolved that a professional would need pinned down before confidently pricing or executing the work -- not just anything that reads as vague. This covers (not limited to):
- A contradiction between two sections or documents (different numbers, dates, or requirements for the same thing).
- A missing technical parameter, quantity, or specification that materially affects pricing or risk (e.g. "temperature-controlled" with no target range, a load rating with no units, a compliance requirement with no referenced standard/code).
- An unresolved responsibility -- unclear whether the client or the contractor owns a component, a permit, a piece of installation/removal work, or a logistics requirement (disposal, storage, security, etc.).
- A real discrepancy between the drawings/bid set and the written scope of work.
- Any other concrete aspect of the project that lacks the detail needed to bid or execute it with confidence.

Never propose a question about: something already answered anywhere in the provided documents, or a purely administrative/procedural detail with no bearing on scope, price, or execution (submission format, who to contact, deadline logistics). When genuinely unsure whether something counts as a real gap versus routine administrative boilerplate, lean toward including it if it could plausibly change a number in the bid -- err toward the side that respects the reader's judgment to disregard a borderline one, not toward silently dropping a real gap. An empty list is still the correct, valuable answer for a well-written RFP with no real gaps -- not a failure to find something. A false alarm here costs a reviewer's confidence in this feature (and, if sent, the client's confidence in the bidder) more than a missed one costs a second look at the RFP.

For each question:
- question: the exact text to send to the client -- professional, specific, never revealing that an AI wrote it.
- rationale: one sentence, for the estimator's own use only, explaining why this matters.
- sourceQuote: a short verbatim quote from the document proving where the gap or ambiguity is -- an exact substring, never a paraphrase.
- documentFilename: the exact filename (from the "Document:" header) this quote came from.`;

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

  const documentsBlock = buildScopeDocumentsBlock(
    scopeDocuments.map((d) => ({ filename: d.filename, extractedText: d.extractedText! })),
  );

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `SCOPE DOCUMENTS:\n\n${documentsBlock}` },
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
