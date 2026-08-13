// Shared "which documents count as scope documents, and how do we fit
// them into a prompt" logic -- pulled out once a second AI feature
// (clarification-questions-service.ts) needed the exact same thing
// scope-coverage-service.ts already had as a private helper. Kept
// deliberately narrow to this one concern: this is NOT chat-context-
// service.ts's job (that one builds a whole opportunity's context,
// priority-ranked, for an open-ended conversation) -- this is just the
// "give me this job's real scope, as compact bullets" building block
// both scope-based analysis features need.

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

// A previous version of this file sent raw extractedText here, bounded
// by a truncation budget -- that ran straight into two real problems:
// this account's actual OpenAI org-level rate limit for gpt-4o is 30,000
// tokens PER MINUTE (confirmed by hitting a 429 directly with a real
// 46,579-token request against this exact Super Bowl RFP package), and
// even under that budget, blind/proportional truncation still cut a real
// 84,125-character contract down to a fraction of its content.
//
// Both problems disappear by construction now: scope-coverage-service.ts
// and clarification-questions-service.ts no longer send raw document
// text to the expensive cross-document model at all. Instead they send
// these bullets -- already extracted by document-summary-service.ts's
// cheap BASIC_MODEL pass, which reads each document's FULL text (see its
// own MAX_INPUT_CHARS) at Analyze time. No fidelity is lost -- the full
// text still gets read in full, just by the cheap model instead of the
// expensive one -- and the expensive model's input drops from tens of
// thousands of characters to a short bullet list, which is why no
// truncation budget is needed here the way the old raw-text version
// required one.
export interface SummaryBullet {
  text: string;
  sourceQuote: string;
}

export function buildBulletsBlock(documents: { filename: string; bullets: SummaryBullet[] }[]): string {
  return documents
    .map((d) => {
      const lines =
        d.bullets.length > 0
          ? d.bullets.map((b) => `- ${b.text} (quote: "${b.sourceQuote}")`).join("\n")
          : "(none extracted)";
      return `Document: ${d.filename}\n${lines}`;
    })
    .join("\n\n---\n\n");
}
