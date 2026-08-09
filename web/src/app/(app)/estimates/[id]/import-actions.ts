"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { commitPricingImport } from "@/lib/pricing-import-service";
import { recomputeVersionTotals, updateLineItem } from "@/lib/estimate-service";

export async function previewImportAction(estimateId: string, formData: FormData) {
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose a document to import from");
  redirect(`/estimates/${estimateId}?importDocumentId=${documentId}`);
}

export async function commitImportAction(
  estimateId: string,
  versionId: string,
  documentId: string,
) {
  await commitPricingImport(versionId, documentId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}`);
}

export async function updateLineItemUnitCostAction(
  estimateId: string,
  versionId: string,
  lineItemId: string,
  formData: FormData,
) {
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(unitCost)) throw new Error("Unit cost must be a number");

  await updateLineItem(lineItemId, { unitCost });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}
