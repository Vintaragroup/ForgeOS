"use server";

import {
  addAttachment,
  addLineItem,
  addOption,
  addSection,
  archiveEstimate,
  assertEstimateNotArchived,
  clearBoothPendingDescription,
  clearCategoryMarginOverride,
  clearSectionPendingDescription,
  confirmDraftLineItem,
  createEstimateVersion,
  createNewVersionFromLocked,
  deleteLineItem,
  lockEstimateVersion,
  moveLineItemsToCategory,
  moveLineItemWithinSection,
  moveSectionOrder,
  recomputeVersionTotals,
  restoreLineItem,
  setCategoryMarginOverride,
  unarchiveEstimate,
  updateBoothDescription,
  updateLineItem,
  updateMarginTarget,
  updateSectionBuildType,
  updateSectionDescription,
} from "@/lib/estimate-service";
import { suggestBoothDescription, suggestSectionDescription } from "@/lib/ai/section-description-service";
import { approveEstimateVersion, generateProposal } from "@/lib/proposal-service";
import { inferCategoryFromDescription, inferIsClientOwned } from "@/lib/line-item-category";
import { recordCostActual } from "@/lib/cost-actual-service";
import { assertVersionBelongsToEstimate, estimateOpportunityId, requireEstimateAccess } from "@/lib/opportunity-access";
import type { LineItemType, LineItemUsageTag, SectionBuildType, SectionType } from "@/generated/prisma/enums";
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
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const marginTargetPct = Number(formData.get("marginTargetPct"));
  if (!Number.isFinite(marginTargetPct)) throw new Error("Margin target must be a number");
  await updateMarginTarget(versionId, marginTargetPct);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function setCategoryMarginOverrideAction(
  estimateId: string,
  versionId: string,
  categoryId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const marginPct = Number(formData.get("marginPct"));
  if (!Number.isFinite(marginPct)) throw new Error("Margin must be a number");
  await setCategoryMarginOverride(versionId, categoryId, marginPct);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function clearCategoryMarginOverrideAction(estimateId: string, versionId: string, categoryId: string) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await clearCategoryMarginOverride(versionId, categoryId);
  revalidatePath(`/estimates/${estimateId}`);
}

// Plain <form action>, same shape as updateMarginTargetAction just
// above -- deliberately NOT wrapped in useActionState. That was tried
// here first (to show a confirmation without confirmAllDraftLineItemsAction's
// redirect+query-param approach, which froze this page's browser tab on
// a real ~330-item estimate -- every category tab's content is
// pre-rendered and hydrated at once, see Tabs' own header comment).
// useActionState made it categorically worse, not better: the tab never
// reached document_idle at all on that same real estimate (confirmed
// live, in a fresh tab, ruling out cold-start or session cruft) even
// though the server returned 200 with no runtime errors -- something
// about a bound server action nested that way never settles client-side.
// Reverted to this plain, unwrapped form (identical posture to
// updateMarginTargetAction, already proven fast on this same estimate)
// until useActionState's failure mode here is understood outside
// production. No success banner for now as a result -- see this
// project's memory / conversation history before reintroducing one.
export async function addSectionAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Section name is required");
  const sectionType = String(formData.get("sectionType")) as SectionType;
  // Blank -- the common case -- means project-wide, no group at all.
  // Typing an existing group's exact name reuses it (a new H2 inside
  // that H1); typing anything else creates a brand-new, independent
  // group (a new H1) -- see the form's own comment in page.tsx.
  const groupLabel = String(formData.get("groupLabel") ?? "").trim() || null;

  await addSection(versionId, { name, sectionType, groupLabel });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateSectionBuildTypeAction(
  estimateId: string,
  versionId: string,
  groupLabel: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const buildType = String(formData.get("buildType")) as SectionBuildType;
  await updateSectionBuildType(versionId, groupLabel, buildType);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function untagSectionBuildTypeAction(estimateId: string, versionId: string, groupLabel: string) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await updateSectionBuildType(versionId, groupLabel, null);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateSectionItemsCategoryAction(
  estimateId: string,
  versionId: string,
  sectionId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const category = String(formData.get("category") ?? "").trim();
  if (!category) throw new Error("Category is required");
  await moveLineItemsToCategory(versionId, { sectionId }, category);
  revalidatePath(`/estimates/${estimateId}`);
}

// Called directly as a function from move-selected-items-bar.tsx, not
// bound to a <form action> -- same reasoning as createBidPackageAction's
// own header comment: the selected line-item ids live in client
// selection state (bid-package-selection.tsx), not real form fields.
export async function bulkMoveLineItemsCategoryAction(
  estimateId: string,
  versionId: string,
  data: { category: string; lineItemIds: string[] },
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const category = data.category.trim();
  if (!category) throw new Error("Choose a category to move the selected items to.");
  if (data.lineItemIds.length === 0) throw new Error("Select at least one line item to move.");
  await moveLineItemsToCategory(versionId, { lineItemIds: data.lineItemIds }, category);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function moveSectionAction(estimateId: string, sectionId: string, direction: "up" | "down") {
  await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  await moveSectionOrder(opportunityId, sectionId, direction);
  revalidatePath(`/estimates/${estimateId}`);
}

// The three section-heading-editor.tsx actions -- see its own header
// comment for the Empty/Pending/Approved state machine these drive.
// "Suggest with AI" (Empty -> Pending) and "regenerate" (Approved/Pending
// -> Pending again) are the same call.
export async function suggestSectionDescriptionAction(estimateId: string, sectionId: string) {
  const user = await requireEstimateAccess(estimateId);
  await suggestSectionDescription(sectionId, user.id);
  revalidatePath(`/estimates/${estimateId}`);
}

// Approve (green check, formData carries the pending text back unchanged)
// or a manual save (formData carries the user's own typed text) -- either
// way this is the one call that ever writes `description`.
export async function updateSectionDescriptionAction(estimateId: string, sectionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Description is required");
  await updateSectionDescription(sectionId, description);
  revalidatePath(`/estimates/${estimateId}`);
}

// Reject (red X) -- reverts to the Empty state.
export async function clearSectionPendingDescriptionAction(estimateId: string, sectionId: string) {
  await requireEstimateAccess(estimateId);
  await clearSectionPendingDescription(sectionId);
  revalidatePath(`/estimates/${estimateId}`);
}

// Booth-level counterparts, for the H1 heading -- same three actions,
// keyed by (versionId, groupLabel) instead of a single sectionId since a
// booth is every section sharing one groupLabel (see
// EstimateSection.boothDescription's own schema comment).
export async function suggestBoothDescriptionAction(estimateId: string, versionId: string, groupLabel: string) {
  const user = await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await suggestBoothDescription(versionId, groupLabel, user.id);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateBoothDescriptionAction(
  estimateId: string,
  versionId: string,
  groupLabel: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Description is required");
  await updateBoothDescription(versionId, groupLabel, description);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function clearBoothPendingDescriptionAction(estimateId: string, versionId: string, groupLabel: string) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await clearBoothPendingDescription(versionId, groupLabel);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function addOptionAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
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
  await assertVersionBelongsToEstimate(estimateId, versionId);
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
  const user = await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
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
  // Manual disambiguation for a genuinely ambiguous material (PVC, for
  // one) -- never inferred, unlike category/isClientOwned above.
  const usageTag = emptyToNull(formData.get("usageTag")) as LineItemUsageTag | null;
  const unit = emptyToNull(formData.get("unit"));
  const qty = Number(formData.get("qty"));
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(qty) || !Number.isFinite(unitCost)) {
    throw new Error("Qty and unit cost must be numbers");
  }
  const isDraft = formData.get("isDraft") === "on";
  const attachmentId = emptyToNull(formData.get("attachmentId"));

  await addLineItem(
    versionId,
    sectionId,
    {
      lineType,
      description,
      department,
      category,
      isClientOwned,
      usageTag,
      qty,
      unit,
      unitCost,
      isDraft,
      attachmentId,
    },
    user.id,
  );
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
  const user = await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Line item description is required");
  const lineType = String(formData.get("lineType")) as LineItemType;
  const department = emptyToNull(formData.get("department"));
  // Same auto-detect-on-blank fallback as addLineItemAction, so clearing
  // the category back to "— auto-detect —" during an edit behaves the
  // same way it would have at creation time.
  const category = emptyToNull(formData.get("category")) ?? inferCategoryFromDescription(description, await fetchActiveCategories());
  const isClientOwned = formData.get("isClientOwned") === "on" || inferIsClientOwned(description);
  const usageTag = emptyToNull(formData.get("usageTag")) as LineItemUsageTag | null;
  const unit = emptyToNull(formData.get("unit"));
  const qty = Number(formData.get("qty"));
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(qty) || !Number.isFinite(unitCost)) {
    throw new Error("Qty and unit cost must be numbers");
  }

  await updateLineItem(
    opportunityId,
    lineItemId,
    {
      description,
      lineType,
      department,
      category,
      isClientOwned,
      usageTag,
      qty,
      unit,
      unitCost,
    },
    user.id,
  );
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function moveLineItemAction(estimateId: string, lineItemId: string, direction: "up" | "down") {
  await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  await moveLineItemWithinSection(opportunityId, lineItemId, direction);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function deleteLineItemAction(estimateId: string, lineItemId: string) {
  const user = await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const { estimateVersionId } = await deleteLineItem(opportunityId, lineItemId, user.id);
  await recomputeVersionTotals(estimateVersionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function restoreLineItemAction(estimateId: string, auditLogId: string) {
  const user = await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const { estimateVersionId } = await restoreLineItem(opportunityId, auditLogId, user.id);
  await recomputeVersionTotals(estimateVersionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function confirmDraftLineItemAction(estimateId: string, lineItemId: string) {
  await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  await confirmDraftLineItem(opportunityId, lineItemId);
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
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await lockEstimateVersion(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function createNewVersionAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await createNewVersionFromLocked(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function approveVersionAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const approvedById = String(formData.get("approvedById") ?? "").trim();
  if (!approvedById) throw new Error("Select who is approving this version");
  await approveEstimateVersion(versionId, approvedById);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function generateProposalAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const templateId = String(formData.get("templateId") ?? "").trim();
  if (!templateId) throw new Error("Select a proposal template");
  const proposal = await generateProposal(versionId, templateId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/proposals/${proposal.id}`);
}

export async function recordCostActualAction(estimateId: string, lineItemId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const actualCost = Number(formData.get("actualCost"));
  if (!Number.isFinite(actualCost)) throw new Error("Actual cost must be a number");
  const source = emptyToNull(formData.get("source"));
  const recordedById = emptyToNull(formData.get("recordedById"));

  await recordCostActual({ opportunityId, lineItemId, actualCost, source, recordedById });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateEstimateDetails(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const estimate = await db.estimate.findUniqueOrThrow({ where: { id: estimateId }, select: { id: true, archivedAt: true } });
  assertEstimateNotArchived(estimate);
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

// Redirects back to the estimate's own page (not the Opportunity, unlike
// this action's old delete-flavored behavior) -- an archived estimate
// stays fully viewable, so the natural next screen is the Archived
// banner/Unarchive control there, not being routed away from it.
export async function archiveEstimateAction(estimateId: string, opportunityId: string) {
  await requireEstimateAccess(estimateId);
  await archiveEstimate(estimateId);
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}`);
}

export async function unarchiveEstimateAction(estimateId: string, opportunityId: string) {
  await requireEstimateAccess(estimateId);
  await unarchiveEstimate(estimateId);
  revalidatePath(`/opportunities/${opportunityId}`);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}`);
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
