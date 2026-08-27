"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createBidPackage,
  recomputeVersionTotals,
  removeLineItemFromBidPackage,
  setBidPackageStatus,
  updateLineItem,
} from "@/lib/estimate-service";
import { assignDocumentBidPackage } from "@/lib/document-service";
import { proposeVendorQuoteLineItems } from "@/lib/ai/vendor-quote-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  assertBidPackageBelongsToEstimate,
  assertVersionBelongsToEstimate,
  estimateOpportunityId,
  requireEstimateAccess,
} from "@/lib/opportunity-access";

// Called directly as a function from create-bid-package-bar.tsx, not
// bound to a <form action> -- the selected line-item ids live in client
// selection state (bid-package-selection.tsx), not in real form fields,
// so a plain object argument fits this call site better than FormData
// would. Server Actions are callable either way; this one just doesn't
// happen to be a form submission.
export async function createBidPackageAction(
  estimateId: string,
  versionId: string,
  data: { name: string; vendorName?: string; lineItemIds: string[] },
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const name = data.name.trim();
  if (!name) throw new Error("Name this bid package before creating it.");

  await createBidPackage(versionId, {
    name,
    vendorName: data.vendorName?.trim() || null,
    lineItemIds: data.lineItemIds,
  });
  revalidatePath(`/estimates/${estimateId}`);
}

export async function attachVendorQuoteDocumentAction(estimateId: string, bidPackageId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose a vendor quote document to attach.");

  await assignDocumentBidPackage(opportunityId, documentId, bidPackageId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function proposeVendorQuoteItemsAction(estimateId: string, bidPackageId: string, documentId: string) {
  const user = await requireEstimateAccess(estimateId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);
  const opportunityId = await estimateOpportunityId(estimateId);
  // documentId scoped to THIS bid package, not trusted alone -- opportunityId
  // alone would let a documentId from a different package in the same
  // Opportunity slip through, same cross-resource ID gap class every other
  // action in this file (and opportunity-access.ts generally) guards
  // against, just one level further down the chain.
  await db.document.findFirstOrThrow({ where: { id: documentId, bidPackageId } });

  try {
    await proposeVendorQuoteLineItems(documentId, opportunityId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    throw err;
  }
  await setBidPackageStatus(bidPackageId, "QUOTE_RECEIVED");
  revalidatePath(`/estimates/${estimateId}`);
}

// Applies one accepted vendor-line match onto a real LineItem row --
// unitCost/documentId/sourceQuote come from hidden fields baked into the
// match row at render time (the match table itself is recomputed live
// on every render, never persisted -- see vendor-match-service.ts's own
// header comment), and isDraft flips to false: the vendor-match review
// the user just did *is* the human-review step, not a separate
// confirmDraftLineItem click after it.
export async function applyVendorMatchAction(
  estimateId: string,
  versionId: string,
  lineItemId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const opportunityId = await estimateOpportunityId(estimateId);

  const unitCost = Number(formData.get("unitCost"));
  const documentId = String(formData.get("documentId") ?? "").trim();
  const sourceQuote = String(formData.get("sourceQuote") ?? "");
  if (!Number.isFinite(unitCost)) throw new Error("Unit cost must be a number.");
  if (!documentId) throw new Error("Missing vendor quote document reference.");

  await updateLineItem(opportunityId, lineItemId, { unitCost, documentId, sourceQuote, isDraft: false });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function removeLineItemFromBidPackageAction(estimateId: string, lineItemId: string) {
  await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  await removeLineItemFromBidPackage(opportunityId, lineItemId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function markBidPackageReviewedAction(estimateId: string, bidPackageId: string) {
  await requireEstimateAccess(estimateId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);
  await setBidPackageStatus(bidPackageId, "REVIEWED");
  revalidatePath(`/estimates/${estimateId}`);
}
