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

// DRAWING and MEETING_NOTES used to be excluded too (drawings have no
// extractedText; meeting notes didn't exist as a type), but both now
// produce the same compact scopeSummary/candidateGaps bullets every other
// document type does (drawing-summary-service.ts's vision pipeline,
// meeting-notes-summary-service.ts's transcript pipeline) -- neither
// Scope Coverage nor Clarification Questions needs raw extractedText
// anymore (see buildBulletsBlock below), so there's no more reason to
// exclude them. resolveClarificationQuestions/resolveCoverageGaps already
// tolerate a null extractedText gracefully for drawing-sourced facts; the
// same tolerance now also covers meeting-notes facts.
//
// PRICING_SCHEDULE used to be excluded outright, on the reasoning that
// its rows already become line items mechanically (pricing-import-
// service.ts) so there was nothing left for a scope analysis to check.
// That held for a schedule the deterministic importers could actually
// read -- it stops holding the moment a real spreadsheet format neither
// recognizes (spreadsheet-line-item-service.ts's AI fallback exists for
// exactly this): a whole package's worth of real pricing can sit in a
// PRICING_SCHEDULE-tagged file that never became a single line item, and
// the old exclusion made that invisible to Scope Coverage too, not just
// to import. A schedule that WAS cleanly imported doesn't false-positive
// here either -- its content is already reflected in real line items, so
// the coverage prompt (which compares against what's already priced) has
// nothing left to flag.
export async function getScopeDocuments(opportunityId: string) {
  return db.document.findMany({
    where: { opportunityId, deletedAt: null, extractionStatus: "COMPLETE" },
    orderBy: { createdAt: "desc" },
  });
}

// The multi-project building block: real Estimate id+name pairs for an
// Opportunity, but ONLY when there are 2+ of them -- a single-estimate
// Opportunity (the overwhelming common case) gets an empty array back,
// which every extraction schema treats as "don't ask for project
// classification at all," not "classify against one project." Keeping
// this check here (not "return whatever exists") is what makes the
// whole multi-project feature opt-in and free for every other
// Opportunity in the app.
export interface ProjectContext {
  estimates: { id: string; name: string }[];
}

export async function getProjectContext(opportunityId: string): Promise<ProjectContext> {
  const estimates = await db.estimate.findMany({
    where: { opportunityId, deletedAt: null, name: { not: null } },
    select: { id: true, name: true },
  });
  const named = estimates.filter((e): e is { id: string; name: string } => e.name !== null);
  return { estimates: named.length >= 2 ? named : [] };
}

// Resolves a model-returned project label back to a real Estimate id --
// never trusted raw, same "resolve against known truth" discipline this
// session already applies to hallucinated filenames and candidate ids
// (see clarification-questions-service.ts). A label that doesn't match
// any real Estimate name (hallucinated, garbled, or the literal
// "SHARED") falls back to null -- shared/unclassified -- rather than
// erroring, so a bad classification degrades safely instead of losing
// the fact entirely.
export function resolveProjectTag(rawProject: string | null | undefined, context: ProjectContext): string | null {
  if (!rawProject || context.estimates.length === 0) return null;
  const normalized = rawProject.trim().toLowerCase();
  const match = context.estimates.find((e) => e.name.trim().toLowerCase() === normalized);
  return match?.id ?? null;
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
  // Optional -- an older stored summary or a single-estimate Opportunity
  // simply won't have this. undefined and null both mean the same thing
  // (shared/unclassified) wherever this is read.
  estimateId?: string | null;
}

// Keeps a bullet if it's shared/unclassified OR tagged to the estimate
// actually being analyzed -- drops anything tagged to the OTHER
// project. Applied before buildBulletsBlock for any estimate-scoped
// caller (Scope Coverage, which is inherently per-estimate already); a
// caller with no particular estimate in mind (Clarification Questions,
// which stays opportunity-wide) skips this and sees every bullet.
export function filterBulletsForEstimate<T extends { estimateId?: string | null }>(
  bullets: T[],
  targetEstimateId: string,
): T[] {
  return bullets.filter((b) => b.estimateId == null || b.estimateId === targetEstimateId);
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
