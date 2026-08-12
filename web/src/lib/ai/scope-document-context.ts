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

// Equal split across documents, not priority-ranked like chat-context-
// service.ts -- unlike chat's open-ended corpus, this is a bounded, opt-in
// set (a job's own scope documents, typically a handful), so equal
// division is sufficient; a job with an unusually large number of scope
// documents could see individual documents clipped, which is a known,
// visible-in-testing simplification, not a silent failure mode.
export const MAX_SCOPE_DOCUMENT_CHARS = 60_000;

export function buildScopeDocumentsBlock(documents: { filename: string; extractedText: string }[]): string {
  const perDocBudget = Math.floor(MAX_SCOPE_DOCUMENT_CHARS / documents.length);
  return documents
    .map((d) => `Document: ${d.filename}\n\n${d.extractedText.slice(0, perDocBudget)}`)
    .join("\n\n---\n\n");
}
