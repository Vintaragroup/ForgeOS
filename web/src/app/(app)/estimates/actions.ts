"use server";

import {
  addAttachment,
  addLineItem,
  addOption,
  addSection,
  archiveEstimate,
  confirmDraftLineItem,
  createEstimateVersion,
  createNewVersionFromLocked,
  deleteLineItem,
  lockEstimateVersion,
  moveLineItemWithinSection,
  moveSectionOrder,
  recomputeVersionTotals,
  updateLineItem,
  updateMarginTarget,
} from "@/lib/estimate-service";
import { approveEstimateVersion, generateProposal } from "@/lib/proposal-service";
import { inferCategoryFromDescription, inferIsClientOwned } from "@/lib/line-item-category";
import { recordCostActual } from "@/lib/cost-actual-service";
import { requireEstimateAccess } from "@/lib/opportunity-access";
import type { LineItemType, SectionType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Every action below takes estimateId as its first bound parameter (see
// the page's .bind(null, estimate.id, ...) calls) -- requireEstimateAccess
// is called first in every one of them, not trusted from the page's own
// gate, for the same reason every /admin action self-checks with
// requireAdmin() rather than relying on the admin layout (see auth.ts).

export async function createFirstVersion(estimateId: string) {
  await requireEstimateAccess(estimateId);
  await createEstimateVersion(estimateId, 0);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateMarginTargetAction(
  estimateId: string,
  versionId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  const marginTargetPct = Number(formData.get("marginTargetPct"));
  if (!Number.isFinite(marginTargetPct)) throw new Error("Margin target must be a number");
  await updateMarginTarget(versionId, marginTargetPct);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addSectionAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Section name is required");
  const sectionType = String(formData.get("sectionType")) as SectionType;

  await addSection(versionId, { name, sectionType });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function moveSectionAction(estimateId: string, sectionId: string, direction: "up" | "down") {
  await requireEstimateAccess(estimateId);
  await moveSectionOrder(sectionId, direction);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addOptionAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
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
  await requireEstimateAccess(estimateId);
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
  await requireEstimateAccess(estimateId);
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Line item description is required");
  const lineType = String(formData.get("lineType")) as LineItemType;
  const department = emptyToNull(formData.get("department"));
  // Left unset ("— auto-detect —" in the form), fall back to the same
  // description heuristic the pricing-schedule import path uses -- see
  // line-item-category.ts. Only fetches categories when actually needed
  // (most edits pick an explicit category from the dropdown).
  const category = emptyToNull(formData.get("category")) ?? inferCategoryFromDescription(description, await fetchActiveCategories());
  // The checkbox is an explicit override; unchecked, fall back to the same
  // description heuristic import paths use -- see line-item-category.ts.
  const isClientOwned = formData.get("isClientOwned") === "on" || inferIsClientOwned(description);
  const unit = emptyToNull(formData.get("unit"));
  const qty = Number(formData.get("qty"));
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(qty) || !Number.isFinite(unitCost)) {
    throw new Error("Qty and unit cost must be numbers");
  }
  const isDraft = formData.get("isDraft") === "on";
  const attachmentId = emptyToNull(formData.get("attachmentId"));

  await addLineItem(sectionId, {
    lineType,
    description,
    department,
    category,
    isClientOwned,
    qty,
    unit,
    unitCost,
    isDraft,
    attachmentId,
  });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

// General-purpose edit for an existing (non-draft-only) line item --
// draft line items already have their own narrower unitCost-only editor
// (import-actions.ts's updateLineItemUnitCostAction, tied to the confirm
// workflow); this covers every field on any line item, added so a
// mis-categorized or manually-priced row (e.g. a labor line added before
// the labor-rate picker existed) can be corrected in place instead of
// deleted and re-added.
export async function updateLineItemAction(
  estimateId: string,
  versionId: string,
  lineItemId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Line item description is required");
  const lineType = String(formData.get("lineType")) as LineItemType;
  const department = emptyToNull(formData.get("department"));
  // Same auto-detect-on-blank fallback as addLineItemAction, so clearing
  // the category back to "— auto-detect —" during an edit behaves the
  // same way it would have at creation time.
  const category = emptyToNull(formData.get("category")) ?? inferCategoryFromDescription(description, await fetchActiveCategories());
  const isClientOwned = formData.get("isClientOwned") === "on" || inferIsClientOwned(description);
  const unit = emptyToNull(formData.get("unit"));
  const qty = Number(formData.get("qty"));
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(qty) || !Number.isFinite(unitCost)) {
    throw new Error("Qty and unit cost must be numbers");
  }

  await updateLineItem(lineItemId, {
    description,
    lineType,
    department,
    category,
    isClientOwned,
    qty,
    unit,
    unitCost,
  });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function moveLineItemAction(estimateId: string, lineItemId: string, direction: "up" | "down") {
  await requireEstimateAccess(estimateId);
  await moveLineItemWithinSection(lineItemId, direction);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function deleteLineItemAction(estimateId: string, lineItemId: string) {
  await requireEstimateAccess(estimateId);
  const { estimateVersionId } = await deleteLineItem(lineItemId);
  await recomputeVersionTotals(estimateVersionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function confirmDraftLineItemAction(estimateId: string, lineItemId: string) {
  await requireEstimateAccess(estimateId);
  await confirmDraftLineItem(lineItemId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addAttachmentAction(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const fileRef = String(formData.get("fileRef") ?? "").trim();
  if (!fileRef) throw new Error("File reference is required");
  const uploadedById = emptyToNull(formData.get("uploadedById"));

  await addAttachment(estimateId, { fileRef, uploadedById });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function lockVersionAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  await lockEstimateVersion(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function createNewVersionAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  await createNewVersionFromLocked(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function approveVersionAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const approvedById = String(formData.get("approvedById") ?? "").trim();
  if (!approvedById) throw new Error("Select who is approving this version");
  await approveEstimateVersion(versionId, approvedById);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function generateProposalAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const templateId = String(formData.get("templateId") ?? "").trim();
  if (!templateId) throw new Error("Select a proposal template");
  const proposal = await generateProposal(versionId, templateId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/proposals/${proposal.id}`);
}

export async function recordCostActualAction(estimateId: string, lineItemId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const actualCost = Number(formData.get("actualCost"));
  if (!Number.isFinite(actualCost)) throw new Error("Actual cost must be a number");
  const source = emptyToNull(formData.get("source"));
  const recordedById = emptyToNull(formData.get("recordedById"));

  await recordCostActual({ lineItemId, actualCost, source, recordedById });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateEstimateDetails(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const budgetRaw = String(formData.get("budget") ?? "").trim();
  const taxRateId = emptyToNull(formData.get("taxRateId"));

  await db.estimate.update({
    where: { id: estimateId },
    data: {
      budget: budgetRaw === "" ? null : Number(budgetRaw),
      taxRateId,
    },
  });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function archiveEstimateAction(estimateId: string, opportunityId: string) {
  await requireEstimateAccess(estimateId);
  await archiveEstimate(estimateId);
  revalidatePath(`/opportunities/${opportunityId}`);
  redirect(`/opportunities/${opportunityId}`);
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

// The categorization heuristics resolve a category by its live name via a
// stable key (see line-item-category.ts's resolveCategoryNameFromKey), so
// the auto-detect fallback below needs a freshly fetched catalog, not the
// categoryOptions list already threaded through the page's own props
// (that one's built at render time and may be stale by submit time).
function fetchActiveCategories() {
  return db.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
}
