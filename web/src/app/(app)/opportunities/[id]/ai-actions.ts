"use server";

// Kept separate from ../actions.ts (plain Opportunity CRUD) the same way
// estimates/[id]/import-actions.ts is kept separate from
// estimates/actions.ts -- an AI-triggering action doesn't belong in a
// plain-CRUD actions file.

import { revalidatePath } from "next/cache";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { runClarificationQuestionsAnalysis } from "@/lib/ai/clarification-questions-service";
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
    throw err;
  }
  revalidatePath(`/opportunities/${opportunityId}`);
}
