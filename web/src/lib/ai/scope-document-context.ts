// Shared "which documents count as scope documents, and how do we fit
// them into a prompt" logic -- pulled out once a second AI feature
// (clarification-questions-service.ts) needed the exact same thing
// scope-coverage-service.ts already had as a private helper. Kept
// deliberately narrow to this one concern: this is NOT chat-context-
// service.ts's job (that one builds a whole opportunity's context,
// priority-ranked, for an open-ended conversation) -- this is just the
// bounded "give me this job's real scope text" building block both
// scope-based analysis features need.

import { db } from "@/lib/db";

// Pricing-schedule rows already become line items mechanically
// (pricing-import-service.ts), and drawings go through a separate vision
// pipeline with no extractedText at all -- neither belongs in a text-based
// scope analysis. Same document set as the estimate page's Risk &
// Compliance Flags / "Propose items from Scope of Work". Deliberately
// narrower than ProjectBriefCard's own document filter (opportunities/
// [id]/page.tsx), which intentionally includes drawings for its
// Key Dates/Risk Flags display -- reusing that broader filter here would
// crash on a null extractedText.
export async function getScopeDocuments(opportunityId: string) {
  return db.document.findMany({
    where: {
      opportunityId,
      deletedAt: null,
      extractionStatus: "COMPLETE",
      documentType: { notIn: ["PRICING_SCHEDULE", "DRAWING"] },
    },
    orderBy: { createdAt: "desc" },
  });
}

// Bounded by a real, external constraint, not just "how much fits in the
// model's context window": this account's actual OpenAI org-level rate
// limit for gpt-4o is 30,000 tokens PER MINUTE (a single request, not a
// running total) -- confirmed by hitting it directly. A first attempt at
// this constant (250,000 chars, sized only against gpt-4o's 128K-token
// context window) produced a real 46,579-token request against this
// exact Super Bowl RFP package and got a 429 rate_limit_exceeded back,
// not a context-window error. That run also revealed this dense
// legal/technical text tokenizes at roughly 3.45 chars/token, denser
// than the ~4 chars/token planning assumption. 70,000 chars (~20,300
// tokens at that real ratio) leaves comfortable headroom under 30,000
// for the system prompt (~600 tokens) plus a generous output reservation
// (multiple questions/gaps, each a full JSON object) -- see
// clarification-questions-service.ts / scope-coverage-service.ts's own
// handling of a 429 that still gets through despite this margin.
//
// This is a real, meaningful improvement over the original 60,000 it
// replaced even though it isn't dramatically higher -- the water-filling
// allocation below is what actually matters now: the original bug was as
// much "budget wasted on documents that didn't need it" as "budget too
// small," and fixing the allocation gets most of the real benefit within
// whatever total this account's rate limit allows.
export const MAX_SCOPE_DOCUMENT_CHARS = 70_000;

// Water-filling, not a blind equal split: a short document (e.g. a
// one-page event schedule) doesn't need its full equal share, and that
// unused slack should go to a document still being truncated rather than
// sit wasted -- confirmed necessary against the same real RFP above,
// where blind equal division wasted most of a 1,085-character document's
// 50,000-character share while a genuine 84,125-character contract was
// still cut down to 12,000. Processes smallest-first so every document
// gets its true length whenever the remaining budget can afford it, and
// only the documents that still can't fit get proportionally clipped.
export function buildScopeDocumentsBlock(documents: { filename: string; extractedText: string }[]): string {
  const bySizeAsc = [...documents].sort((a, b) => a.extractedText.length - b.extractedText.length);
  const allocated = new Map<string, number>();
  let budgetLeft = MAX_SCOPE_DOCUMENT_CHARS;
  let docsLeft = bySizeAsc.length;
  for (const d of bySizeAsc) {
    const fairShare = Math.floor(budgetLeft / docsLeft);
    const take = Math.min(d.extractedText.length, fairShare);
    allocated.set(d.filename, take);
    budgetLeft -= take;
    docsLeft -= 1;
  }
  return documents
    .map((d) => `Document: ${d.filename}\n\n${d.extractedText.slice(0, allocated.get(d.filename)!)}`)
    .join("\n\n---\n\n");
}
