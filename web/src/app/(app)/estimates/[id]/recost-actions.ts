"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireEstimateAccess } from "@/lib/opportunity-access";
import { decideRecostProposal } from "@/lib/recost-apply-service";
import { proposeFromCostBreakout } from "@/lib/recost-row-proposal-service";
import { proposeRecostChanges } from "@/lib/ai/recost-proposal-service";
import { catchUserError } from "@/lib/user-error";
import type { ActionResult } from "@/lib/user-error";

// Runs the one AI stage of the re-cost review.
//
// Explicitly triggered rather than run on page load, for the same reason
// a drawing comparison is: it costs a real model call, and the findings
// it works from do not change until somebody uploads another document.
//
// Returned rather than thrown, because Next redacts errors thrown out of
// a Server Action in production -- "an error occurred in the Server
// Components render" is what an estimator would otherwise see when the
// compared drawing has been deleted.
export async function proposeRecostChangesAction(
  estimateId: string,
  _prev: ActionResult,
  _formData: FormData,
): Promise<ActionResult> {
  const user = await requireEstimateAccess(estimateId);

  return catchUserError(async () => {
    const run = await proposeRecostChanges(estimateId, user.id);
    revalidatePath(`/estimates/${estimateId}`);
    return run;
  });
}

// Records an estimator's answer to one proposal, and applies it when
// there is something to apply.
//
// One proposal per call, never a bulk accept. Every row came from a
// model reading a drawing, and "accept all" is the affordance that turns
// a reviewed list into an unreviewed one.
export async function decideRecostProposalAction(
  estimateId: string,
  proposalId: string,
  decision: "ACCEPT" | "REJECT",
  _prev: ActionResult,
  _formData: FormData,
): Promise<ActionResult> {
  const user = await requireEstimateAccess(estimateId);
  const estimate = await db.estimate.findUniqueOrThrow({
    where: { id: estimateId },
    select: { opportunityId: true },
  });

  return catchUserError(async () => {
    await decideRecostProposal(proposalId, estimate.opportunityId, user.id, decision);
    revalidatePath(`/estimates/${estimateId}`);
  });
}

// Generates proposals from the row-by-row workbook comparison.
//
// Separate action from the AI one because it is a separate kind of
// evidence: no model, an exact join, and the estimating lead's own
// numbers. Costs nothing to run, so it can be re-run freely.
export async function proposeFromCostBreakoutAction(
  estimateId: string,
  _prev: ActionResult,
  _formData: FormData,
): Promise<ActionResult> {
  const user = await requireEstimateAccess(estimateId);

  return catchUserError(async () => {
    await proposeFromCostBreakout(estimateId, user.id);
    revalidatePath(`/estimates/${estimateId}`);
  });
}
