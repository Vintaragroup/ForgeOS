"use server";

import { approveChangeOrder, createChangeOrder, rejectChangeOrder } from "@/lib/change-order-service";
import { assertVersionBelongsToEstimate, requireEstimateAccess } from "@/lib/opportunity-access";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createChangeOrderAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Describe what this change order covers");

  const changeOrder = await createChangeOrder(estimateId, versionId, description);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/change-orders/${changeOrder.id}`);
}

export async function approveChangeOrderAction(changeOrderId: string, estimateId: string) {
  await requireEstimateAccess(estimateId);
  await approveChangeOrder(estimateId, changeOrderId);
  revalidatePath(`/change-orders/${changeOrderId}`);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function rejectChangeOrderAction(changeOrderId: string, estimateId: string) {
  await requireEstimateAccess(estimateId);
  await rejectChangeOrder(estimateId, changeOrderId);
  revalidatePath(`/change-orders/${changeOrderId}`);
  revalidatePath(`/estimates/${estimateId}`);
}
