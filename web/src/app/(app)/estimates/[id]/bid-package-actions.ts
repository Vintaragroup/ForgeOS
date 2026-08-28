"use server";

import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import {
  addLineItemsBulk,
  createBidPackage,
  findOrCreateSection,
  recomputeVersionTotals,
  removeLineItemFromBidPackage,
  setBidPackageStatus,
  updateLineItem,
} from "@/lib/estimate-service";
import { assignDocumentBidPackage } from "@/lib/document-service";
import { proposeVendorQuoteLineItems } from "@/lib/ai/vendor-quote-service";
import {
  matchVendorQuoteLinesWithAi,
  type ProposedVendorSection,
  type VendorLineMatch,
  type VendorQuoteLine,
} from "@/lib/ai/vendor-match-ai-service";
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
    // Candidates are every line item on the CURRENT ESTIMATE VERSION, not
    // just ones already added to this bid package -- the version (built
    // from the client's own source-of-truth spreadsheet import) is almost
    // always far bigger than the handful of items a reviewer happened to
    // check off into one bid package. applyVendorMatchAction below adds a
    // matched item to this package at apply time, so scoping candidates
    // this way is what actually lets a vendor line reach the real
    // corresponding item instead of only ever the pre-selected few.
    const { estimateVersionId } = await db.bidPackage.findUniqueOrThrow({
      where: { id: bidPackageId },
      select: { estimateVersionId: true },
    });
    const lineItems = await db.lineItem.findMany({
      where: { section: { estimateVersionId } },
      include: { section: { select: { name: true, groupLabel: true } } },
    });
    const candidates = lineItems.map((li) => ({
      id: li.id,
      description: li.description,
      sectionLabel: li.section.groupLabel ?? li.section.name,
      qty: li.qty.toNumber(),
      unit: li.unit,
    }));
    const { matches, proposedSections } = await matchVendorQuoteLinesWithAi(
      vendorLines,
      candidates,
      opportunityId,
      documentId,
      userId,
    );

    await db.bidPackage.update({
      where: { id: bidPackageId },
      data: {
        matchResult: matches as unknown as Prisma.InputJsonValue,
        proposedSections: proposedSections as unknown as Prisma.InputJsonValue,
        vendorExtractionPhase: "COMPLETE",
      },
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
// match row at render time, and isDraft flips to false: the vendor-match
// review the user just did *is* the human-review step, not a separate
// confirmDraftLineItem click after it.
// lineItemId comes from the row's own <select> now, not a value baked
// into the bound action at render time -- a match review row lets the
// user pick ANY line item on the current estimate version, not just ones
// already added to this bid package (see runVendorExtractionAndMatch's
// own comment on why the candidate pool is version-wide: the version,
// built from the client's own source-of-truth spreadsheet import, is
// almost always far bigger than the handful of items originally checked
// into one bid package). Ownership is checked against versionId here --
// not bidPackageId, and not trusted from the form alone -- same
// cross-resource-ID discipline every other action in this file follows,
// just scoped one level up: a tampered lineItemId could otherwise be
// pointed at a line item on a completely different estimate. Applying a
// match to a line item outside this package moves it in: a vendor price
// now applies to it, so it belongs to this vendor's package.
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
  await db.lineItem.findFirstOrThrow({ where: { id: lineItemId, section: { estimateVersionId: versionId } } });

  await updateLineItem(opportunityId, lineItemId, { unitCost, documentId, sourceQuote, isDraft: false, bidPackageId });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

// Turns one AI-proposed section (vendor-match-ai-service.ts's own header
// comment explains why this is judged in the same matching call, not a
// second pass) into a real EstimateSection + priced, non-draft
// LineItems. Clicking "Create section" IS the human review step, same
// posture applyVendorMatchAction already established for an
// existing-candidate match -- not a draft awaiting a later confirm.
// findOrCreateSection is idempotent (matches on name + groupLabel), so
// this is safe even if the section already exists from an earlier
// partial commit or another bid package's own proposal for the same
// category.
//
// proposal.vendorLineIndices are positions in the SAME vendorLines/
// matches array (see ProposedVendorSection's own comment) -- used here
// to pull the real vendor line data straight from the persisted
// matchResult, and again afterward to patch those exact matches entries
// to point at the newly created line items, so the review table shows
// them resolved immediately instead of merely newly selectable.
export async function commitProposedVendorSectionAction(
  estimateId: string,
  versionId: string,
  bidPackageId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);

  const rawProposedSectionIndex = formData.get("proposedSectionIndex");
  const proposedSectionIndex = rawProposedSectionIndex !== null ? Number(rawProposedSectionIndex) : NaN;
  if (!Number.isInteger(proposedSectionIndex) || proposedSectionIndex < 0) {
    throw new Error("Missing or invalid proposed section reference.");
  }

  const bidPackage = await db.bidPackage.findUniqueOrThrow({
    where: { id: bidPackageId },
    include: { documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } } },
  });
  const proposedSections = (bidPackage.proposedSections as unknown as ProposedVendorSection[] | null) ?? [];
  const proposal = proposedSections[proposedSectionIndex];
  if (!proposal) throw new Error("This proposed section no longer exists -- try Re-extract.");
  const quoteDocument = bidPackage.documents[0];
  if (!quoteDocument) throw new Error("No vendor quote document attached to this package.");

  const matches = (bidPackage.matchResult as unknown as VendorLineMatch[] | null) ?? [];
  // Filtered and mapped together, in lockstep, so `created[k]` is
  // guaranteed to correspond to `validVendorIndices[k]` even if some
  // index in the proposal no longer resolves -- a plain re-map back
  // through the ORIGINAL (unfiltered) vendorLineIndices below would
  // misalign every entry after the first gap.
  const validVendorIndices = proposal.vendorLineIndices.filter((i) => !!matches[i]?.vendorLine);
  if (validVendorIndices.length === 0) {
    throw new Error("None of this proposal's vendor lines are still available -- try Re-extract.");
  }
  const vendorLinesToCreate = validVendorIndices.map((i) => matches[i].vendorLine);

  const section = await findOrCreateSection(versionId, { name: proposal.name, sectionType: "CATEGORY" });
  const created = await addLineItemsBulk(
    versionId,
    section.id,
    vendorLinesToCreate.map((vl) => ({
      lineType: proposal.lineType,
      description: vl.description,
      qty: vl.qty ?? 1,
      unit: vl.unit,
      unitCost: vl.unitPrice,
      documentId: quoteDocument.id,
      sourceQuote: vl.sourceQuote,
      sourcePageNumber: vl.pageNumber,
    })),
    { isDraft: false, bidPackageId },
  );

  const createdIdByVendorIndex = new Map(validVendorIndices.map((vendorIndex, k) => [vendorIndex, created[k]?.id]));
  const updatedMatches = matches.map((m, i) => {
    const newLineItemId = createdIdByVendorIndex.get(i);
    if (!newLineItemId) return m;
    return {
      ...m,
      lineItemId: newLineItemId,
      confidence: "high" as const,
      reasoning: `Matched to newly created section "${proposal.name}".`,
      needsClarification: false,
    };
  });
  const remainingProposals = proposedSections.filter((_, i) => i !== proposedSectionIndex);

  await db.bidPackage.update({
    where: { id: bidPackageId },
    data: {
      matchResult: updatedMatches as unknown as Prisma.InputJsonValue,
      proposedSections: remainingProposals as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath(`/estimates/${estimateId}`);
}

// An explicit decline, not silent -- just removes the entry so it stops
// being offered. Doesn't touch matchResult; those vendor lines stay
// exactly as flagged (needsClarification etc.) for manual resolution via
// the per-row dropdown instead.
export async function dismissProposedVendorSectionAction(estimateId: string, bidPackageId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  await assertBidPackageBelongsToEstimate(estimateId, bidPackageId);

  const rawProposedSectionIndex = formData.get("proposedSectionIndex");
  const proposedSectionIndex = rawProposedSectionIndex !== null ? Number(rawProposedSectionIndex) : NaN;
  if (!Number.isInteger(proposedSectionIndex) || proposedSectionIndex < 0) {
    throw new Error("Missing or invalid proposed section reference.");
  }

  const bidPackage = await db.bidPackage.findUniqueOrThrow({
    where: { id: bidPackageId },
    select: { proposedSections: true },
  });
  const proposedSections = (bidPackage.proposedSections as unknown as ProposedVendorSection[] | null) ?? [];
  const remainingProposals = proposedSections.filter((_, i) => i !== proposedSectionIndex);

  await db.bidPackage.update({
    where: { id: bidPackageId },
    data: { proposedSections: remainingProposals as unknown as Prisma.InputJsonValue },
  });
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
