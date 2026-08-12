// Companion to scope-line-item-service.ts, but the inverse operation:
// instead of proposing NEW line items from a scope document, checks
// whether documented scope requirements are already covered by EXISTING
// line items on the current estimate version. Read-only, advisory --
// never writes a LineItem, never blocks anything. A second pair of eyes
// against the real risk of pricing under the actual RFP scope, not a
// guarantee (see this function's own conservative system prompt: a false
// alarm costs a reviewer's trust more than a missed one costs a second
// look at the source document).

import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { extractPdfPageTexts, locateQuotePage, resolveHighlightableQuote, PDF_MIME } from "@/lib/ai/text-extraction";
import { ADVANCED_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";
import { getDocumentBytes } from "@/lib/document-service";
import { getScopeDocuments, buildScopeDocumentsBlock } from "@/lib/ai/scope-document-context";

export interface CoverageGap {
  requirement: string;
  // Verbatim quote from the source document, verified against its
  // extractedText -- resolveHighlightableQuote below, same discipline as
  // document-summary-service.ts / scope-line-item-service.ts.
  sourceQuote: string;
  // Which scope document this gap's quote came from -- a coverage run can
  // span several documents at once, unlike scope-line-item-service.ts's
  // single-document proposal flow.
  documentId: string;
  // Named to match citationHref's `fact` param directly (see citation.ts)
  // -- unlike ProposedLineItem's sourcePageNumber, a CoverageGap is never
  // committed into a LineItem, so there's no LineItem.sourcePageNumber
  // naming convention to match instead.
  pageNumber: number | null;
}

export interface RawCoverageGap {
  requirement: string;
  sourceQuote: string;
  documentFilename: string;
}

const REQUIREMENT_DESCRIPTION =
  "A concise (under 200 characters) description, in your own words, of the specific scope requirement or deliverable that does not appear to be priced anywhere in the current line items.";
const SOURCE_QUOTE_DESCRIPTION =
  "A short (under 150 characters) quote copied EXACTLY, character-for-character, from that document's text above, showing where this requirement is stated. Never paraphrase or summarize the quote itself.";

export const COVERAGE_SCHEMA = {
  name: "scope_coverage_gaps",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      gaps: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            requirement: { type: "string", description: REQUIREMENT_DESCRIPTION },
            sourceQuote: { type: "string", description: SOURCE_QUOTE_DESCRIPTION },
            documentFilename: {
              type: "string",
              description: "The exact filename (as given in the \"Document:\" header above) this quote came from.",
            },
          },
          required: ["requirement", "sourceQuote", "documentFilename"],
        },
      },
    },
    required: ["gaps"],
  },
} as const;

const SYSTEM_PROMPT = `You compare a Scope of Work / RFP document against a contractor's current list of priced line items for the same job, and flag any concrete deliverable or requirement stated in the document that does not appear to be covered by ANY of the current line items.

Only flag genuine gaps in scope coverage -- concrete work, materials, or deliverables the document asks for that you cannot find a reasonably matching line item for. Do not flag: administrative/legal/insurance/payment-terms clauses, anything already covered even if worded differently than the document (e.g. a line item "Booth fabrication" covers a requirement for "construct exhibit structure"), or vague scope-summary language that isn't itself a distinct deliverable. When in doubt, do not flag it -- returning an empty array is the correct, useful answer for a document whose scope is already fully covered; a false alarm costs a reviewer's trust in this feature more than a missed one costs a second look at the RFP.

For each gap:
- requirement: a concise description, in your own words, of the specific uncovered requirement.
- sourceQuote: a short verbatim quote from the document proving the document actually asked for this -- an exact substring, never a paraphrase.
- documentFilename: the exact filename (from the "Document:" header) this quote came from.`;

function buildLineItemsBlock(
  sections: { name: string; lineItems: { description: string; qty: Prisma.Decimal; unit: string | null; category: string | null }[] }[],
): string {
  const lines = sections.flatMap((s) =>
    s.lineItems.map((li) => {
      const qty = `${li.qty.toString()}${li.unit ? ` ${li.unit}` : ""}`;
      const category = li.category ? `, ${li.category}` : "";
      return `- [${s.name}] ${li.description} (${qty}${category})`;
    }),
  );
  return lines.length > 0 ? lines.join("\n") : "(no line items yet)";
}

// Separated from runScopeCoverageAnalysis below so it's directly testable
// without a live OpenAI call -- takes the model's raw response shape and
// does everything after it: drop hallucinated filenames, verify quotes
// against real extracted text, resolve real PDF page numbers. Mirrors why
// commitScopeLineItems is a separate, independently-testable function
// from proposeLineItemsFromScope in scope-line-item-service.ts.
export async function resolveCoverageGaps(
  rawGaps: RawCoverageGap[],
  scopeDocuments: { id: string; filename: string; extractedText: string | null; mimeType: string }[],
): Promise<CoverageGap[]> {
  const pageTextsByDocument = new Map<string, string[] | null>();
  async function getPageTextsFor(doc: (typeof scopeDocuments)[number]): Promise<string[] | null> {
    if (doc.mimeType !== PDF_MIME) return null;
    if (pageTextsByDocument.has(doc.id)) return pageTextsByDocument.get(doc.id)!;
    const { bytes } = await getDocumentBytes(doc.id);
    const pageTexts = await extractPdfPageTexts(bytes);
    pageTextsByDocument.set(doc.id, pageTexts);
    return pageTexts;
  }

  const gaps: CoverageGap[] = [];
  for (const rawGap of rawGaps) {
    // A filename that doesn't match any document actually sent is a
    // hallucination -- dropped rather than stored as a dangling reference.
    const doc = scopeDocuments.find((d) => d.filename === rawGap.documentFilename);
    if (!doc || !doc.extractedText) continue;
    const sourceQuote = resolveHighlightableQuote(doc.extractedText, rawGap.sourceQuote);
    const pageTexts = await getPageTextsFor(doc);
    gaps.push({
      requirement: rawGap.requirement,
      sourceQuote,
      documentId: doc.id,
      pageNumber: pageTexts ? locateQuotePage(pageTexts, sourceQuote) : null,
    });
  }
  return gaps;
}

export async function runScopeCoverageAnalysis(estimateVersionId: string, userId: string | null = null) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: {
      estimate: true,
      sections: { where: { optionId: null }, include: { lineItems: true } },
    },
  });

  const scopeDocuments = await getScopeDocuments(version.estimate.opportunityId);
  if (scopeDocuments.length === 0) {
    throw new Error("No analyzed scope documents yet -- click Analyze on a document from the Opportunity page first.");
  }

  // Throws AiNotConfiguredError before any DB write, same posture as
  // proposeLineItemsFromScope / summarizeDocument.
  const client = getOpenAiClient();

  const allLineItems = version.sections.flatMap((s) => s.lineItems);
  const lineItemsBlock = buildLineItemsBlock(version.sections);
  const documentsBlock = buildScopeDocumentsBlock(
    scopeDocuments.map((d) => ({ filename: d.filename, extractedText: d.extractedText! })),
  );

  const completion = await client.chat.completions.create({
    model: ADVANCED_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `CURRENT LINE ITEMS:\n${lineItemsBlock}\n\nSCOPE DOCUMENTS:\n\n${documentsBlock}`,
      },
    ],
    response_format: { type: "json_schema", json_schema: COVERAGE_SCHEMA },
  });

  await recordAiUsage({
    userId,
    feature: "SCOPE_COVERAGE_ANALYSIS",
    model: ADVANCED_MODEL,
    usage: completion.usage,
    opportunityId: version.estimate.opportunityId,
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("OpenAI returned an empty response.");
  const parsed = JSON.parse(content) as { gaps: RawCoverageGap[] };
  const gaps = await resolveCoverageGaps(parsed.gaps, scopeDocuments);

  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: {
      coverageAnalysis: {
        generatedAt: new Date().toISOString(),
        lineItemCount: allLineItems.length,
        gaps,
      } as unknown as Prisma.InputJsonValue,
    },
  });
}
