"use server";

// Kept separate from ../actions.ts (plain Opportunity CRUD) the same way
// estimates/[id]/import-actions.ts is kept separate from
// estimates/actions.ts -- an AI-triggering action doesn't belong in a
// plain-CRUD actions file.

import { revalidatePath } from "next/cache";
import { RateLimitError } from "openai";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { runClarificationQuestionsAnalysis } from "@/lib/ai/clarification-questions-service";
import { regenerateTimeline } from "@/lib/timeline-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";

// Read-only advisory check, same posture as estimates' runScopeCoverage
// AnalysisAction: never mutates anything but the cached
// clarificationQuestions result itself. No redirect/query param needed --
// there's exactly one clarificationQuestions blob per opportunity, so the
// page just re-reads it after revalidation.
export async function runClarificationQuestionsAnalysisAction(opportunityId: string) {
  const user = await requireOpportunityAccess(opportunityId);
  try {
    await runClarificationQuestionsAnalysis(opportunityId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    // Confirmed real, not theoretical: a large multi-document RFP can
    // genuinely exceed this account's OpenAI org-level rate limit for a
    // single request (see scope-document-context.ts's own comment on the
    // 429 this hit in practice) -- surfaced as a clear, retryable message
    // instead of a raw SDK error/500.
    if (err instanceof RateLimitError) {
      throw new Error("OpenAI's rate limit was hit for this request -- wait a minute and try again.");
    }
    throw err;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
}

// Regenerates the Timeline card -- deterministic fields always refresh,
// the 5 AI-classified milestone types get one fresh extraction pass, but
// any row an estimator has hand-edited (source MANUAL) survives the
// re-run untouched (see timeline-service.ts's regenerateTimeline). Safe to
// call even with no scope documents analyzed yet -- the deterministic and
// rush-fee-default milestones still populate; only the AI-sourced ones
// stay flagged as missing.
export async function regenerateTimelineAction(opportunityId: string) {
  const user = await requireOpportunityAccess(opportunityId);
  try {
    await regenerateTimeline(opportunityId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    if (err instanceof RateLimitError) {
      throw new Error("OpenAI's rate limit was hit for this request -- wait a minute and try again.");
    }
    throw err;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
}
