"use server";

import { revalidatePath } from "next/cache";
import { requireEstimateAccess } from "@/lib/opportunity-access";
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
