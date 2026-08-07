"use server";

import {
  addAttachment,
  addLineItem,
  addOption,
  addSection,
  confirmDraftLineItem,
  createEstimateVersion,
  createNewVersionFromLocked,
  deleteLineItem,
  lockEstimateVersion,
  recomputeVersionTotals,
  updateMarginTarget,
} from "@/lib/estimate-service";
import { approveEstimateVersion, generateProposal } from "@/lib/proposal-service";
import type { LineItemType, SectionType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createFirstVersion(estimateId: string) {
  await createEstimateVersion(estimateId, 0);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateMarginTargetAction(
  estimateId: string,
  versionId: string,
  formData: FormData,
) {
  const marginTargetPct = Number(formData.get("marginTargetPct"));
  if (!Number.isFinite(marginTargetPct)) throw new Error("Margin target must be a number");
  await updateMarginTarget(versionId, marginTargetPct);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addSectionAction(estimateId: string, versionId: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Section name is required");
  const sectionType = String(formData.get("sectionType")) as SectionType;

  await addSection(versionId, { name, sectionType });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addOptionAction(estimateId: string, versionId: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Option name is required");

  await addOption(versionId, { name });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addOptionSectionAction(
  estimateId: string,
  versionId: string,
  optionId: string,
  formData: FormData,
) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Section name is required");
  const sectionType = String(formData.get("sectionType")) as SectionType;

  await addSection(versionId, { name, sectionType, optionId });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addLineItemAction(
  estimateId: string,
  versionId: string,
  sectionId: string,
  formData: FormData,
) {
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Line item description is required");
  const lineType = String(formData.get("lineType")) as LineItemType;
  const department = emptyToNull(formData.get("department"));
  const qty = Number(formData.get("qty"));
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(qty) || !Number.isFinite(unitCost)) {
    throw new Error("Qty and unit cost must be numbers");
  }
  const isDraft = formData.get("isDraft") === "on";
  const attachmentId = emptyToNull(formData.get("attachmentId"));

  await addLineItem(sectionId, { lineType, description, department, qty, unitCost, isDraft, attachmentId });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function deleteLineItemAction(estimateId: string, lineItemId: string) {
  const { estimateVersionId } = await deleteLineItem(lineItemId);
  await recomputeVersionTotals(estimateVersionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function confirmDraftLineItemAction(estimateId: string, lineItemId: string) {
  await confirmDraftLineItem(lineItemId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addAttachmentAction(estimateId: string, formData: FormData) {
  const fileRef = String(formData.get("fileRef") ?? "").trim();
  if (!fileRef) throw new Error("File reference is required");
  const uploadedById = emptyToNull(formData.get("uploadedById"));

  await addAttachment(estimateId, { fileRef, uploadedById });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function lockVersionAction(estimateId: string, versionId: string) {
  await lockEstimateVersion(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function createNewVersionAction(estimateId: string, versionId: string) {
  await createNewVersionFromLocked(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function approveVersionAction(estimateId: string, versionId: string, formData: FormData) {
  const approvedById = String(formData.get("approvedById") ?? "").trim();
  if (!approvedById) throw new Error("Select who is approving this version");
  await approveEstimateVersion(versionId, approvedById);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function generateProposalAction(estimateId: string, versionId: string, formData: FormData) {
  const templateId = String(formData.get("templateId") ?? "").trim();
  if (!templateId) throw new Error("Select a proposal template");
  const proposal = await generateProposal(versionId, templateId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/proposals/${proposal.id}`);
}

export async function updateEstimateDetails(estimateId: string, formData: FormData) {
  const budgetRaw = String(formData.get("budget") ?? "").trim();
  const taxCity = emptyToNull(formData.get("taxCity"));

  await db.estimate.update({
    where: { id: estimateId },
    data: {
      budget: budgetRaw === "" ? null : Number(budgetRaw),
      taxCity,
    },
  });
  revalidatePath(`/estimates/${estimateId}`);
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
