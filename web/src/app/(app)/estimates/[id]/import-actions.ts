"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { RateLimitError } from "openai";
import { commitPricingImport } from "@/lib/pricing-import-service";
import type { SheetDestination } from "@/lib/ai/spreadsheet-line-item-service";
import { commitScopeLineItems, proposeLineItemsFromScope } from "@/lib/ai/scope-line-item-service";
import { proposeLineItemsFromDrawing } from "@/lib/ai/drawing-line-item-service";
import { runScopeCoverageAnalysis } from "@/lib/ai/scope-coverage-service";
import { buildEstimateFromAllDocuments } from "@/lib/ai/estimate-synthesis-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { reconcilePullSheetAgainstExcel } from "@/lib/cad-reconciliation-service";
import {
  confirmAllDraftLineItems,
  recategorizeLineItems,
  recomputeVersionTotals,
  updateLineItem,
} from "@/lib/estimate-service";
import { assertVersionBelongsToEstimate, estimateOpportunityId, requireEstimateAccess } from "@/lib/opportunity-access";
import { db } from "@/lib/db";

// opportunityId is intentionally NOT trusted from the parameter below --
// see estimate-service.ts's deleteLineItem for the general rationale. A
// mismatched opportunityId here specifically risks pulling a DIFFERENT
// opportunity's uploaded documents into this estimate's AI-synthesized
// line items, a content-leak vector this AI pipeline is uniquely exposed
// to (buildEstimateFromAllDocuments reads every document under
// opportunityId). Re-resolved fresh from estimateId instead; the
// parameter is kept only so this action's existing .bind(...) call site
// (estimates/[id]/page.tsx) doesn't need to change.
export async function buildFullEstimateFromDocumentsAction(
  estimateId: string,
  versionId: string,
  _opportunityId: string,
) {
  const user = await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const result = await buildEstimateFromAllDocuments(versionId, opportunityId, user.id);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?tab=documents&buildResult=${encodeURIComponent(JSON.stringify(result))}`);
}

export async function runClientTemplateReconciliationAction(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose the client's pricing template document");
  redirect(`/estimates/${estimateId}?tab=review&reconcileDocumentId=${documentId}`);
}

export async function previewImportAction(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose a document to import from");
  // tab=documents preserved explicitly -- the Tabs component (tabs.tsx)
  // falls back to its first tab ("Line Items") whenever the URL's own
  // `tab` param is missing, and this redirect replaces the whole query
  // string. Without it, a successful preview (with real rows and a
  // Commit button) renders invisibly on the Documents tab while the user
  // lands back on Line Items seeing no change at all -- confirmed live,
  // this was reported as "I clicked import and nothing was added."
  redirect(`/estimates/${estimateId}?tab=documents&importDocumentId=${documentId}`);
}

export async function commitImportAction(
  estimateId: string,
  versionId: string,
  documentId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  // Only present when the preview flagged one or more alternate-option
  // groups (spreadsheet-line-item-service.ts's findAlternateGroups) --
  // every other "Commit" form on this page still submits with no matching
  // fields at all, which is exactly "everything goes to the base version,"
  // this function's unchanged default.
  const sheetDestinations: Record<string, SheetDestination> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("destination__")) continue;
    const sheetName = key.slice("destination__".length);
    if (value === "option") {
      const optionName = String(formData.get(`optionName__${sheetName}`) ?? "").trim();
      if (optionName) sheetDestinations[sheetName] = { target: "option", optionName };
    }
  }
  await commitPricingImport(versionId, documentId, sheetDestinations);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?tab=documents`);
}

export async function proposeScopeItemsAction(estimateId: string, formData: FormData) {
  const user = await requireEstimateAccess(estimateId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const documentId = String(formData.get("documentId") ?? "").trim();
  if (!documentId) throw new Error("Choose a document to propose items from");

  try {
    // Same dispatch shape as analyze-document.ts -- a DRAWING has no
    // extracted text, so it needs the vision-based proposer instead of
    // the text-based one, but both write the identical ProposedLineItem[]
    // shape, so everything downstream (this action's redirect, the
    // preview table, commitScopeItemsAction) needs no branch of its own.
    const { documentType } = await db.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { documentType: true },
    });
    if (documentType === "DRAWING") {
      await proposeLineItemsFromDrawing(documentId, opportunityId, user.id);
    } else {
      await proposeLineItemsFromScope(documentId, opportunityId, user.id);
    }
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    throw err;
  }
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?tab=documents&proposeDocumentId=${documentId}`);
}

export async function commitScopeItemsAction(
  estimateId: string,
  versionId: string,
  documentId: string,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  await commitScopeLineItems(versionId, documentId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?tab=documents`);
}

// Read-only advisory check, unlike every other action in this file --
// never mutates a LineItem, so no recomputeVersionTotals call and no
// restriction on a locked version (arguably most useful right before
// generating a proposal). No redirect/query param needed, matching
// updateLineItemUnitCostAction below: there's exactly one
// coverageAnalysis blob per version, not one per document, so the page
// just re-reads currentVersion.coverageAnalysis after revalidation.
export async function runScopeCoverageAnalysisAction(estimateId: string, versionId: string) {
  const user = await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  try {
    await runScopeCoverageAnalysis(versionId, user.id);
  } catch (err) {
    if (err instanceof AiNotConfiguredError) {
      throw new Error("AI features aren't configured yet -- add OPENAI_API_KEY to enable this.");
    }
    // Same shared scope-document-context.ts budget and ADVANCED_MODEL call
    // as opportunities/[id]/ai-actions.ts's clarification-questions
    // action -- equally exposed to this account's real 30,000 TPM org
    // rate limit on a large multi-document RFP, so it gets the identical
    // graceful handling.
    if (err instanceof RateLimitError) {
      throw new Error("OpenAI's rate limit was hit for this request -- wait a minute and try again.");
    }
    throw err;
  }
  revalidatePath(`/estimates/${estimateId}`);
}

export async function updateLineItemUnitCostAction(
  estimateId: string,
  versionId: string,
  lineItemId: string,
  formData: FormData,
) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const unitCost = Number(formData.get("unitCost"));
  if (!Number.isFinite(unitCost)) throw new Error("Unit cost must be a number");

  await updateLineItem(opportunityId, lineItemId, { unitCost });
  await recomputeVersionTotals(versionId);
  revalidatePath(`/estimates/${estimateId}`);
}

export async function confirmAllDraftLineItemsAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const count = await confirmAllDraftLineItems(opportunityId, versionId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?tab=line-items&confirmedCount=${count}`);
}

export async function recategorizeLineItemsAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  await assertVersionBelongsToEstimate(estimateId, versionId);
  const opportunityId = await estimateOpportunityId(estimateId);
  const { checked, updated } = await recategorizeLineItems(opportunityId, versionId);
  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}?tab=review&recategorized=${updated}&recategorizeChecked=${checked}`);
}

// Read-only audit, same posture as runScopeCoverageAnalysisAction above --
// never mutates a LineItem. Unlike that action, its result isn't a single
// per-version blob, so it's carried through the redirect's own query
// param, same ephemeral-result pattern proposeScopeItemsAction/buildResult
// already use.
export async function reconcilePullSheetAction(estimateId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  const cadDocumentId = String(formData.get("cadDocumentId") ?? "").trim();
  const excelDocumentId = String(formData.get("excelDocumentId") ?? "").trim();
  if (!cadDocumentId || !excelDocumentId) {
    throw new Error("Choose both a CAD drawing and its matching Excel quote");
  }
  const result = await reconcilePullSheetAgainstExcel(cadDocumentId, excelDocumentId);
  redirect(`/estimates/${estimateId}?tab=documents&reconcileResult=${encodeURIComponent(JSON.stringify(result))}`);
}
