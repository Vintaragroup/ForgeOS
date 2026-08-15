"use server";

import { revalidatePath } from "next/cache";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { deleteLineItem, moveLineItemToEstimate, recomputeVersionTotals } from "@/lib/estimate-service";

// Both actions revalidate the Opportunity page (not /estimates/[id] --
// the audit card lives here) since that's the page these buttons are
// always submitted from; see line-item-audit-service.ts for how a
// misattributed row is found in the first place.

export async function moveLineItemToEstimateAction(opportunityId: string, lineItemId: string, targetEstimateId: string) {
  await requireOpportunityAccess(opportunityId);
  await moveLineItemToEstimate(opportunityId, lineItemId, targetEstimateId);
  revalidatePath(`/opportunities/${opportunityId}`);
}

export async function deleteMisattributedLineItemAction(opportunityId: string, lineItemId: string) {
  await requireOpportunityAccess(opportunityId);
  const { estimateVersionId } = await deleteLineItem(opportunityId, lineItemId);
  await recomputeVersionTotals(estimateVersionId);
  revalidatePath(`/opportunities/${opportunityId}`);
}
