"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { commitPricingImport } from "@/lib/pricing-import-service";
import { commitScopeLineItems, proposeLineItemsFromScope } from "@/lib/ai/scope-line-item-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { recomputeVersionTotals, updateLineItem } from "@/lib/estimate-service";
import { requireEstimateAccess } from "@/lib/opportunity-access";

export async function previewImportAction(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose a document to import from");
  redirect(`/estimates/${estimateId}?importDocumentId=${documentId}`);
}

export async function commitImportAction(
  estimateId: string,
  versionId: string,
  documentId: string,
) {
  await requireEstimateAccess(estimateId);
  await commitPricingImport(versionId, documentId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}`);
}

export async function proposeScopeItemsAction(estimateId: string, formData: FormData) {
  const user = await requireEstimateAccess(estimateId);
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose a document to propose items from");

  try {
    await proposeLineItemsFromScope(documentId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    throw err;
  }
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?proposeDocumentId=${documentId}`);
}

export async function commitScopeItemsAction(
  estimateId: string,
  versionId: string,
  documentId: string,
) {
  await requireEstimateAccess(estimateId);
  await commitScopeLineItems(versionId, documentId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}`);
}

export async function updateLineItemUnitCostAction(
  estimateId: string,
  versionId: string,
  lineItemId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(unitCost)) throw new Error("Unit cost must be a number");

  await updateLineItem(lineItemId, { unitCost });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}
