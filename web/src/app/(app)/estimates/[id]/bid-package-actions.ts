"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  createBidPackage,
  recomputeVersionTotals,
  removeLineItemFromBidPackage,
  setBidPackageStatus,
  updateLineItem,
} from "@/lib/estimate-service";
import { assignDocumentBidPackage } from "@/lib/document-service";
import { proposeVendorQuoteLineItems } from "@/lib/ai/vendor-quote-service";
import { matchVendorQuoteLinesWithAi, type VendorQuoteLine } from "@/lib/ai/vendor-match-ai-service";
import { AiNotConfiguredError, getOpenAiClient } from "@/lib/ai/openai-client";
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

// The real work here -- extraction, then AI matching -- is a genuine
// 30-100+ second pair of OpenAI calls (confirmed live against a real
// 217-line vendor quote). Blocking the Server Action on it left the
// button showing a static "Extracting..." label the whole time with no
// real progress. Instead: do the fast, synchronous part (ownership
// checks, an early AI-configured check so a missing key still fails
// loudly instead of silently in the background, and the first phase
// write) here, then hand the slow part to `after()` -- Next's
// schedule-after-response primitive, backed by Vercel's waitUntil, so it
// keeps running even if the browser disconnects. vendor-extraction-
// progress.tsx polls getBidPackageExtractionStatusAction below to make
// the phase transitions visible; there's no other push channel back to
// the client once the response is sent.
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
    getOpenAiClient();
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    throw err;
  }

  await db.bidPackage.update({
    where: { id: bidPackageId },
    data: { vendorExtractionPhase: "READING_DOCUMENT", vendorExtractionStartedAt: new Date(), vendorExtractionError: null },
  });
  revalidatePath(`/estimates/${estimateId}`);

  after(() =>
    runVendorExtractionAndMatch({ estimateId, bidPackageId, documentId, opportunityId, userId: user.id }),
  );
}

async function runVendorExtractionAndMatch(params: {
  estimateId: string;
  bidPackageId: string;
  documentId: string;
  opportunityId: string;
  userId: string;
}) {
  const { bidPackageId, documentId, opportunityId, userId } = params;
  try {
    await db.bidPackage.update({ where: { id: bidPackageId }, data: { vendorExtractionPhase: "EXTRACTING_LINES" } });
    await proposeVendorQuoteLineItems(documentId, opportunityId, userId);

    await db.bidPackage.update({ where: { id: bidPackageId }, data: { vendorExtractionPhase: "MATCHING" } });
    const document = await db.document.findUniqueOrThrow({ where: { id: documentId } });
    const vendorLines = (document.vendorQuoteLineItems as unknown as VendorQuoteLine[] | null) ?? [];
    const lineItems = await db.lineItem.findMany({
      where: { bidPackageId },
      include: { section: { select: { name: true, groupLabel: true } } },
    });
    const candidates = lineItems.map((li) => ({
      id: li.id,
      description: li.description,
      sectionLabel: li.section.groupLabel ?? li.section.name,
      qty: li.qty.toNumber(),
      unit: li.unit,
    }));
    const matches = await matchVendorQuoteLinesWithAi(vendorLines, candidates, opportunityId, documentId, userId);

    await db.bidPackage.update({
      where: { id: bidPackageId },
      data: { matchResult: matches as unknown as Prisma.InputJsonValue, vendorExtractionPhase: "COMPLETE" },
    });
    await setBidPackageStatus(bidPackageId, "QUOTE_RECEIVED");
  } catch (err) {
    const message =
      err instanceof AiNotConfiguredError
        ? "AI features aren't configured yet -- add OPENAI_API_KEY to enable this."
        : err instanceof Error
          ? err.message
          : "Extraction failed.";
    await db.bidPackage.update({
      where: { id: bidPackageId },
      data: { vendorExtractionPhase: "FAILED", vendorExtractionError: message },
    });
  }
}

// Cheap, access-checked read for vendor-extraction-progress.tsx's poller
// -- called directly as a plain function from a client component, not
// bound to a form, same pattern createBidPackageAction already uses.
export async function getBidPackageExtractionStatusAction(estimateId: string, bidPackageId: string) {
  await requireEstimateAccess(estimateId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);
  const bidPackage = await db.bidPackage.findUniqueOrThrow({
    where: { id: bidPackageId },
    select: { vendorExtractionPhase: true, vendorExtractionError: true },
  });
  return { phase: bidPackage.vendorExtractionPhase, error: bidPackage.vendorExtractionError };
}

// Applies one accepted vendor-line match onto a real LineItem row --
// unitCost/documentId/sourceQuote come from hidden fields baked into the
// match row at render time (the match table itself is recomputed live
// on every render, never persisted -- see vendor-match-service.ts's own
// header comment), and isDraft flips to false: the vendor-match review
// the user just did *is* the human-review step, not a separate
// confirmDraftLineItem click after it.
// lineItemId comes from the row's own <select> now, not a value baked
// into the bound action at render time -- a match review row lets the
// user pick a DIFFERENT line item than the one matchVendorQuoteLines
// suggested (there's no reliable way to auto-resolve the vendor's own
// unit code against this app's section labels, see vendor-match-
// service.ts's own header comment), so the actual target has to be
// read from the submitted form. Verified against bidPackageId here --
// not trusted from the form alone -- same cross-resource-ID discipline
// every other action in this file follows: a tampered lineItemId could
// otherwise be pointed at a line item outside this package entirely.
export async function applyVendorMatchAction(
  estimateId: string,
  versionId: string,
  bidPackageId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);
  const opportunityId = await estimateOpportunityId(estimateId);

  const lineItemId = String(formData.get("lineItemId") ?? "").trim();
  const unitCost = Number(formData.get("unitCost"));
  const documentId = String(formData.get("documentId") ?? "").trim();
  const sourceQuote = String(formData.get("sourceQuote") ?? "");
  if (!lineItemId) throw new Error("Choose which line item this vendor price applies to.");
  if (!Number.isFinite(unitCost)) throw new Error("Unit cost must be a number.");
  if (!documentId) throw new Error("Missing vendor quote document reference.");
  await db.lineItem.findFirstOrThrow({ where: { id: lineItemId, bidPackageId } });

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
