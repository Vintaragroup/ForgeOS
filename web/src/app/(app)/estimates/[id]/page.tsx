import { Suspense } from "react";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import type { Category, Prisma } from "@/generated/prisma/client";
import {
  aggregateByCategory,
  boothGroupsByCategoryForEditing,
  bucketLineItemsByCategory,
  buildTopLevelCategoryViews,
  groupBoothLineItemsForEditing,
  groupPrimaryCategoryTabs,
  mergeBoothGroupsForAllMethods,
  mergeCategoryBucketsForAllMethods,
  type PrimaryCategoryTab,
  type RawBoothGroup,
  type RawCategoryBucket,
} from "@/lib/proposal-view-model";
import { ProposalPreviewModal } from "@/components/proposal-preview-modal";
import {
  addAttachmentAction,
  addLineItemAction,
  addOptionAction,
  addOptionSectionAction,
  addSectionAction,
  approveVersionAction,
  archiveEstimateAction,
  bulkMoveLineItemsCategoryAction,
  clearBoothPendingDescriptionAction,
  clearCategoryMarginOverrideAction,
  clearSectionPendingDescriptionAction,
  confirmDraftLineItemAction,
  createFirstVersion,
  createNewVersionAction,
  deleteLineItemAction,
  generateProposalAction,
  lockVersionAction,
  moveLineItemAction,
  recordCostActualAction,
  restoreLineItemAction,
  setCategoryMarginOverrideAction,
  suggestBoothDescriptionAction,
  suggestSectionDescriptionAction,
  updateBoothDescriptionAction,
  updateEstimateDetails,
  updateLineItemAction,
  updateMarginTargetAction,
  unarchiveEstimateAction,
  untagSectionBuildTypeAction,
  updateSectionBuildTypeAction,
  updateSectionDescriptionAction,
  updateSectionItemsCategoryAction,
} from "../actions";
import { SectionHeadingEditor } from "@/components/section-heading-editor";
import {
  buildFullEstimateFromDocumentsAction,
  commitImportAction,
  commitScopeItemsAction,
  confirmAllDraftLineItemsAction,
  applyPullSheetEnrichmentAction,
  previewImportAction,
  previewPullSheetEnrichmentAction,
  proposeScopeItemsAction,
  recategorizeLineItemsAction,
  reconcilePullSheetAction,
  runClientTemplateReconciliationAction,
  runScopeCoverageAnalysisAction,
} from "./import-actions";
import { reconcileAgainstClientTemplate, type ClientTemplateReconciliation } from "@/lib/client-pricing-template-service";
import type { ReconciliationResult, ReconciliationRow } from "@/lib/cad-reconciliation-service";
import type { EnrichmentPreviewResult } from "@/lib/cad-enrichment-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";
import type { BuildEstimateResult } from "@/lib/ai/estimate-synthesis-service";
import type { CoverageGap } from "@/lib/ai/scope-coverage-service";
import { computeMarginGrossUp, computeOptionTotal, resolveLineItemMarginPct } from "@/lib/estimate-service";
import { previewPricingImport } from "@/lib/pricing-import-service";
import { findAlternateGroups } from "@/lib/ai/spreadsheet-line-item-service";
import { loadCatalogForMatching, matchDescription } from "@/lib/catalog-match-service";
import { taxRateOptionLabel, TAX_RATE_PICKER_QUERY } from "@/lib/tax-rate";
import { laborRateOptionLabel } from "@/lib/labor-rate";
import { LaborRateLineItemFields, type LaborRateOption } from "@/components/labor-rate-line-item-picker";
import { QuantityOrAreaFields } from "@/components/quantity-or-area-fields";
import { LineItemRow } from "@/components/line-item-row";
import type { ProposedLineItem } from "@/lib/ai/scope-line-item-service";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { getProjectContext } from "@/lib/ai/scope-document-context";
import { citationHref, linkifyMentions } from "@/lib/citation";
import { getCitableLineItems, getCitableQuotes, getThreadMessages } from "@/lib/chat-service";
import { ChatWidget } from "@/components/chat-widget";
import { auditLineItemCategories } from "@/lib/category-audit";
import type { SectionBuildType } from "@/generated/prisma/enums";
import { computeActualTotal, computeDepartmentVariance, computeLineItemVariance } from "@/lib/cost-actual-service";
import { getVendorMatchApplyLog } from "@/lib/vendor-match-apply-log-service";
import { buildTypeTotals, type MethodTotal } from "@/lib/type-totals";
import { createChangeOrderAction } from "../../change-orders/actions";
import { ConfirmForm } from "@/components/confirm-form";
import { Button, Card, Field, Notice, PageHeader, SelectField } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { Tabs } from "@/components/tabs";
import { CategoryMethodFilter } from "@/components/category-method-filter";
import { SectionScopedForm } from "@/components/section-scoped-form";
import { findClosestCandidateId, type ProposedVendorSection, type VendorLineMatch } from "@/lib/ai/vendor-match-ai-service";
import { BidPackageSelectionProvider } from "@/components/bid-package-selection";
import { CreateBidPackageBar } from "@/components/create-bid-package-bar";
import { MoveSelectedItemsBar } from "@/components/move-selected-items-bar";
import { VendorExtractionProgress } from "./vendor-extraction-progress";
import {
  applyAllHighConfidenceMatchesAction,
  applySelectedVendorMatchesAction,
  applyVendorMatchAction,
  applyVendorMatchGroupAction,
  attachVendorQuoteDocumentAction,
  commitProposedVendorSectionAction,
  createBidPackageAction,
  dismissProposedVendorSectionAction,
  markBidPackageReviewedAction,
  proposeVendorQuoteItemsAction,
  removeLineItemFromBidPackageAction,
} from "./bid-package-actions";
import { MatchSelectionProvider } from "@/components/match-selection";
import { MatchRowCheckbox } from "@/components/match-row-checkbox";
import { MatchGroupCheckbox } from "@/components/match-group-checkbox";
import { ApplySelectedMatchesBar } from "@/components/apply-selected-matches-bar";

const SECTION_TYPE_OPTIONS = [
  { value: "COMPONENT", label: "Component" },
  { value: "CATEGORY", label: "Category" },
  { value: "FEE", label: "Fee" },
];

const LINE_TYPE_OPTIONS = [
  { value: "MATERIAL", label: "Material" },
  { value: "LABOR", label: "Labor" },
  { value: "FEE", label: "Fee" },
];

// Manual disambiguation for a material that's genuinely ambiguous on its
// own (PVC, for one -- see LineItemUsageTag's own schema comment). Always
// shown, normally left blank -- same posture as the isClientOwned checkbox
// below, a deliberate always-available choice rather than automatic
// show/hide magic keyed off the description text.
const LINE_ITEM_USAGE_TAG_OPTIONS = [
  { value: "", label: "— unspecified —" },
  { value: "RENTAL_PANEL", label: "Rental Panel" },
  { value: "GRAPHIC", label: "Graphic" },
];

function money(d: { toFixed(n: number): string }): string {
  return `$${Number(d.toFixed(2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default async function EstimateDetailPage(props: PageProps<"/estimates/[id]">) {
  const { id } = await props.params;
  const {
    importDocumentId: importDocumentIdParam,
    proposeDocumentId: proposeDocumentIdParam,
    buildResult: buildResultParam,
    applied: appliedParam,
    stale: staleParam,
    confirmedCount: confirmedCountParam,
    recategorized: recategorizedParam,
    recategorizeChecked: recategorizeCheckedParam,
    reconcileDocumentId: reconcileDocumentIdParam,
    reconcileResult: reconcileResultParam,
    enrichCadDocumentId: enrichCadDocumentIdParam,
    enrichResult: enrichResultParam,
    enrichApplied: enrichAppliedParam,
  } = await props.searchParams;
  const importDocumentId = Array.isArray(importDocumentIdParam) ? importDocumentIdParam[0] : importDocumentIdParam;
  const reconcileDocumentId = Array.isArray(reconcileDocumentIdParam) ? reconcileDocumentIdParam[0] : reconcileDocumentIdParam;
  const proposeDocumentId = Array.isArray(proposeDocumentIdParam) ? proposeDocumentIdParam[0] : proposeDocumentIdParam;
  const buildResultRaw = Array.isArray(buildResultParam) ? buildResultParam[0] : buildResultParam;
  // Flash confirmation for every vendor match applied so far this
  // session (see appliedRedirectUrl's own comment in bid-package-actions.ts
  // on why this is a comma-joined accumulator, not a single id -- a
  // single value got clobbered by the next Apply click, making the
  // FIRST row's "✓ Applied" badge disappear even though its data was
  // untouched). Threaded down to BidPackageCard so it can render the
  // badge next to every row (and bulk-apply block) resolved to any of
  // these ids, and rendered back into each form as a hidden field so the
  // next apply can append to it instead of overwriting it.
  const appliedLineItemIds = new Set(
    (Array.isArray(appliedParam) ? appliedParam[0] : appliedParam)?.split(",").filter(Boolean) ?? [],
  );
  // How many high-confidence matches applyAllHighConfidenceMatchesAction
  // just found pointing at a deleted line item and had to skip -- see
  // that action's own comment on why this needed reporting: silently
  // skipping was indistinguishable from the button doing nothing at all
  // (confirmed live).
  const staleMatchCount = Number(Array.isArray(staleParam) ? staleParam[0] : staleParam) || 0;
  const confirmedCount = confirmedCountParam
    ? Number(Array.isArray(confirmedCountParam) ? confirmedCountParam[0] : confirmedCountParam) || 0
    : null;
  const recategorized = recategorizedParam
    ? Number(Array.isArray(recategorizedParam) ? recategorizedParam[0] : recategorizedParam) || 0
    : null;
  const recategorizeChecked =
    Number(Array.isArray(recategorizeCheckedParam) ? recategorizeCheckedParam[0] : recategorizeCheckedParam) || 0;
  let buildResult: BuildEstimateResult | null = null;
  if (buildResultRaw) {
    try {
      buildResult = JSON.parse(buildResultRaw) as BuildEstimateResult;
    } catch {
      buildResult = null; // malformed/tampered query param -- ignore rather than crash the page
    }
  }
  const reconcileResultRaw = Array.isArray(reconcileResultParam) ? reconcileResultParam[0] : reconcileResultParam;
  let reconcileResult: ReconciliationResult | null = null;
  if (reconcileResultRaw) {
    try {
      reconcileResult = JSON.parse(reconcileResultRaw) as ReconciliationResult;
    } catch {
      reconcileResult = null; // malformed/tampered query param -- ignore rather than crash the page
    }
  }
  const enrichCadDocumentId = Array.isArray(enrichCadDocumentIdParam) ? enrichCadDocumentIdParam[0] : enrichCadDocumentIdParam;
  const enrichResultRaw = Array.isArray(enrichResultParam) ? enrichResultParam[0] : enrichResultParam;
  let enrichResult: EnrichmentPreviewResult | null = null;
  if (enrichResultRaw) {
    try {
      enrichResult = JSON.parse(enrichResultRaw) as EnrichmentPreviewResult;
    } catch {
      enrichResult = null; // malformed/tampered query param -- ignore rather than crash the page
    }
  }
  const enrichApplied = enrichAppliedParam
    ? Number(Array.isArray(enrichAppliedParam) ? enrichAppliedParam[0] : enrichAppliedParam) || 0
    : null;

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const estimate = await db.estimate.findFirst({
    where: { id, deletedAt: null },
    include: { opportunity: { include: { company: true } }, taxRate: true },
  });
  if (!estimate) notFound();
  if (!(await canAccessOpportunity(user, estimate.opportunityId))) notFound();

  const versions = await db.estimateVersion.findMany({
    where: { estimateId: estimate.id },
    orderBy: { versionNumber: "desc" },
    include: {
      sections: {
        where: { optionId: null },
        orderBy: { sortOrder: "asc" },
        include: {
          lineItems: {
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
            include: {
              costActuals: true,
              document: { select: { id: true, mimeType: true, filename: true } },
              bidPackage: { select: { id: true, name: true } },
            },
          },
        },
      },
      options: {
        orderBy: { sortOrder: "asc" },
        include: { sections: { orderBy: { sortOrder: "asc" }, include: { lineItems: true } } },
      },
      bidPackages: {
        where: { deletedAt: null },
        orderBy: { createdAt: "asc" },
        include: {
          lineItems: {
            select: {
              id: true,
              description: true,
              category: true,
              qty: true,
              unit: true,
              unitCost: true,
              totalCost: true,
              documentId: true,
              section: { select: { name: true, groupLabel: true } },
            },
          },
          documents: { where: { deletedAt: null }, orderBy: { createdAt: "desc" } },
        },
      },
      approvedBy: true,
      proposals: { orderBy: { createdAt: "desc" } },
      changeOrdersAsBase: { orderBy: { createdAt: "desc" } },
    },
  });

  const currentVersion = versions.find((v) => v.isCurrent) ?? versions[0];
  const olderVersions = versions.filter((v) => v.id !== currentVersion?.id);

  const [
    users,
    proposalTemplates,
    taxRates,
    laborRates,
    categories,
    categoryMarginOverrides,
    attachments,
    pricingScheduleDocuments,
    scopeDocuments,
    vendorQuoteDocuments,
    cadDocuments,
    vendorMatchApplyLog,
    lineItemAuditLog,
    chatMessages,
    allOpportunityDocuments,
    citableLineItems,
    citableQuotes,
  ] = await Promise.all([
    db.user.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.proposalTemplate.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } }),
    db.taxRate.findMany(TAX_RATE_PICKER_QUERY),
    db.laborRate.findMany({
      where: { deletedAt: null },
      orderBy: [{ rateType: "asc" }, { departmentName: "asc" }, { city: "asc" }, { laborTier: "asc" }],
    }),
    db.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } }),
    currentVersion
      ? db.categoryMarginOverride.findMany({ where: { estimateVersionId: currentVersion.id } })
      : Promise.resolve([]),
    db.attachment.findMany({
      where: { estimateId: estimate.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      include: { uploadedBy: true },
    }),
    // VENDOR_QUOTE included alongside PRICING_SCHEDULE so a standalone
    // itemized vendor-quote PDF (e.g. a booth graphics vendor's own
    // pricing table, with no pre-existing line items to match against --
    // see vendor-quote-service.ts's previewStandaloneVendorQuoteImport)
    // shows up in this same "Import from document" picker instead of
    // only under Bid Packages. pricing-import-service.ts's
    // previewPricingImport dispatches on the real document's own
    // documentType/mimeType, not this query, so a VENDOR_QUOTE that
    // happens to be a spreadsheet still goes through the normal XLSX
    // paths unaffected.
    db.document.findMany({
      where: { opportunityId: estimate.opportunityId, documentType: { in: ["PRICING_SCHEDULE", "VENDOR_QUOTE"] }, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    // Any analyzed document EXCEPT a pricing schedule (which already has
    // real qty/unit rows -- an AI guess would be strictly worse) is a
    // candidate to propose line items from -- DRAWING included, via the
    // vision-based drawing-line-item-service.ts (proposeScopeItemsAction
    // dispatches on documentType).
    db.document.findMany({
      where: {
        opportunityId: estimate.opportunityId,
        deletedAt: null,
        extractionStatus: "COMPLETE",
        documentType: { notIn: ["PRICING_SCHEDULE"] },
      },
      orderBy: { createdAt: "desc" },
    }),
    // Unattached VENDOR_QUOTE documents -- feeds the Bid Packages tab's
    // "attach an already-uploaded quote" picker (attachVendorQuoteDocumentAction).
    // Uploaded generically via the Opportunity page's DocumentUploadForm,
    // same as every other document type -- not a package-specific upload
    // widget (see document-service.ts's assignDocumentBidPackage).
    db.document.findMany({
      where: { opportunityId: estimate.opportunityId, documentType: "VENDOR_QUOTE", bidPackageId: null, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    // Feeds the CAD Pull Sheet reconciliation picker (cad-reconciliation-
    // service.ts) -- independent of extractionStatus/AI vision analysis,
    // since that reconciliation reads the PDF's own raw bytes directly and
    // needs no prior "analyze" step to have run.
    db.document.findMany({
      where: { opportunityId: estimate.opportunityId, documentType: "DRAWING", mimeType: PDF_MIME, deletedAt: null },
      orderBy: { createdAt: "desc" },
    }),
    currentVersion ? getVendorMatchApplyLog(currentVersion.id) : Promise.resolve([]),
    // Capped at 200 -- deliberately not unpaginated, per the real
    // performance problem an unpaginated 782-line-item estimate caused
    // earlier this session.
    currentVersion
      ? db.lineItemAuditLog.findMany({
          where: { estimateVersionId: currentVersion.id },
          orderBy: { createdAt: "desc" },
          take: 200,
          include: { actor: { select: { name: true } } },
        })
      : Promise.resolve([]),
    // Same one-thread-per-opportunity chat as the Opportunity page and
    // Document Viewer (chat-service.ts) -- mounted here too so a
    // question can be asked without leaving the estimate.
    getThreadMessages(estimate.opportunityId),
    db.document.findMany({
      where: { opportunityId: estimate.opportunityId, deletedAt: null },
      select: { id: true, filename: true },
    }),
    getCitableLineItems(estimate.opportunityId),
    getCitableQuotes(estimate.opportunityId),
  ]);

  // A Pricing Schedule document stays selectable in "Import from
  // document" forever, even once it's already been committed into THIS
  // version -- confirmed live: a real user re-selected an already-done
  // file with nothing in the UI hinting it was done, and only found out
  // via commitPricingImport's own "already been imported" error after
  // clicking all the way through to Commit. Left selectable (not
  // filtered out entirely) since deleting the old rows and re-importing
  // is a real, if rare, recovery path -- just labeled so a reviewer
  // isn't surprised.
  const importedPricingScheduleDocumentIds =
    currentVersion && pricingScheduleDocuments.length > 0
      ? new Set(
          (
            await db.lineItem.findMany({
              where: {
                documentId: { in: pricingScheduleDocuments.map((d) => d.id) },
                section: { estimateVersionId: currentVersion.id, optionId: null },
              },
              select: { documentId: true },
              distinct: ["documentId"],
            })
          ).map((li) => li.documentId!),
        )
      : new Set<string>();

  // Only non-empty once this Opportunity has 2+ named Estimates (see
  // getProjectContext) -- lets the Propose preview table show which
  // project each item was classified into, so a bad classification can be
  // caught before Commit, not just after (see line-item-audit-service.ts
  // for the after-commit half of this).
  const projectContext = await getProjectContext(estimate.opportunityId);
  const estimateNameById = new Map(projectContext.estimates.map((e) => [e.id, e.name]));

  // Plain-object, pre-formatted rows -- not the raw Prisma LaborRate[]
  // (its `rate` is a Decimal instance, which shouldn't cross into the
  // "use client" picker component as a prop) and not passed as an
  // opaque id needing a further lookup, since the picker needs the
  // department code/rate values up front to autofill the line item form.
  const laborRateOptions = laborRates.map((r) => ({
    id: r.id,
    label: laborRateOptionLabel({ ...r, rate: r.rate.toNumber() }),
    department: r.rateType === "DEPARTMENT" ? r.departmentCode : null,
    rate: r.rate.toNumber(),
  }));

  // Blank stays blank on submit (see emptyToNull in actions.ts) -- left
  // unset, category resolves from a catalog match or the description
  // heuristic instead of a guess forced at entry time. See
  // line-item-category.ts.
  const categoryOptions = [
    { value: "", label: "— auto-detect —" },
    ...categories.map((c) => ({ value: c.name, label: c.name })),
  ];

  const addAttachmentWithId = addAttachmentAction.bind(null, estimate.id);
  const updateEstimateDetailsWithId = updateEstimateDetails.bind(null, estimate.id);
  const createFirstVersionWithId = createFirstVersion.bind(null, estimate.id);
  const previewImportWithId = previewImportAction.bind(null, estimate.id);
  const proposeScopeItemsWithId = proposeScopeItemsAction.bind(null, estimate.id);
  const reconcilePullSheetWithId = reconcilePullSheetAction.bind(null, estimate.id);
  const previewPullSheetEnrichmentWithIds = currentVersion
    ? previewPullSheetEnrichmentAction.bind(null, estimate.id, currentVersion.id)
    : null;
  const applyPullSheetEnrichmentWithIds = currentVersion
    ? applyPullSheetEnrichmentAction.bind(null, estimate.id, currentVersion.id)
    : null;
  const archiveEstimateWithIds = archiveEstimateAction.bind(null, estimate.id, estimate.opportunityId);
  const unarchiveEstimateWithIds = unarchiveEstimateAction.bind(null, estimate.id, estimate.opportunityId);
  const buildEstimateWithIds = currentVersion
    ? buildFullEstimateFromDocumentsAction.bind(null, estimate.id, currentVersion.id, estimate.opportunityId)
    : null;

  const canImport = !!currentVersion && !currentVersion.isLocked;
  const importPreview =
    canImport && importDocumentId
      ? await previewPricingImport(importDocumentId, estimate.opportunityId, user.id).catch((err: Error) => err)
      : null;

  const reconciliation =
    currentVersion && reconcileDocumentId
      ? await reconcileAgainstClientTemplate(currentVersion.id, reconcileDocumentId).catch((err: Error) => err)
      : null;

  // Flag-only mirror check (see design-cost-estimate-import-service.ts's
  // own header comment on why this never auto-copies pricing): a Design
  // Cost Estimate booth workbook's "Build Name" is the one signal in that
  // template that another uploaded document is the SAME design -- one
  // section copied wholesale from another, or re-quantified from it,
  // rather than independently engineered. Confirmed live against 13 real
  // booth workbooks for one RFP: several share a Build Name, one pair
  // byte-identical. Normalized (strip everything but letters/digits) so
  // "A6.6.1 SECTION 330" and "A 6.6.1 SECTION 330" -- the same design,
  // just inconsistently typed across two files -- still match.
  const normalizeBuildName = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const mirrorDocuments =
    importPreview && !(importPreview instanceof Error) && importPreview.kind === "design-cost-estimate" && importPreview.buildName
      ? await db.document
          .findMany({
            where: { opportunityId: estimate.opportunityId, deletedAt: null, buildName: { not: null } },
            select: { id: true, filename: true, buildName: true },
          })
          .then((docs) =>
            docs.filter(
              (d) =>
                d.id !== importDocumentId &&
                d.buildName &&
                normalizeBuildName(d.buildName) === normalizeBuildName(importPreview.buildName!),
            ),
          )
      : [];

  // proposedLineItems is computed once (see the "Propose items" button,
  // scope-line-item-service.ts) and cached on the Document -- reading it
  // here is free, no repeat OpenAI call on every page load/reload.
  const proposeDocument =
    canImport && proposeDocumentId ? scopeDocuments.find((d) => d.id === proposeDocumentId) : null;
  const proposedItems = (proposeDocument?.proposedLineItems as unknown as ProposedLineItem[] | null) ?? null;
  const proposeCatalog = proposedItems && proposedItems.length > 0 ? await loadCatalogForMatching() : [];

  // Same data the Project Brief already shows on the Opportunity page,
  // surfaced here too -- whoever's pricing and signing off on THIS
  // estimate shouldn't have to go find the Opportunity tab to see that a
  // liquidated-damages clause or an insurance minimum applies.
  const riskFlags = scopeDocuments.flatMap((d) => {
    const summary = d.extractedSummary as unknown as DocumentSummary | null;
    if (!summary) return [];
    return summary.riskFlags.map((r) => ({ ...r, doc: d }));
  });

  // Surfaces exactly what aggregateByCategory's isKnownCategory fallback
  // already silently detects on the proposal-facing side -- these items
  // will render under "Other" on the PDF/web view, not their real
  // category, until fixed. sendProposal (proposal-service.ts) hard-blocks
  // on the same check; this banner is the "catch it during editing, not
  // at send time" half of that same safety net.
  const categoryAudit = currentVersion
    ? auditLineItemCategories(currentVersion.sections, categories)
    : { issues: [], methodUnresolvedIssues: [], isClean: true };

  // Read-only advisory check of this version's line items against its
  // scope documents (scope-coverage-service.ts) -- persisted on the
  // version, not recomputed live, since it's an explicitly-triggered,
  // deliberately expensive action, not something to re-run on every page
  // load. Never gated on canImport: it doesn't mutate line items, and is
  // arguably most useful on a locked version, right before generating a
  // proposal.
  const runCoverageAnalysisWithIds = currentVersion
    ? runScopeCoverageAnalysisAction.bind(null, estimate.id, currentVersion.id)
    : null;
  const coverageAnalysis = currentVersion?.coverageAnalysis as unknown as {
    generatedAt: string;
    lineItemCount: number;
    gaps: CoverageGap[];
  } | null;
  // Resolves each gap's documentId back to a real Document for
  // citationHref + filename display -- coverageAnalysis only stores the
  // id, not the full document. Dropped silently if that document was
  // since deleted.
  const coverageGapsWithDocs = coverageAnalysis
    ? coverageAnalysis.gaps.flatMap((gap) => {
        const doc = scopeDocuments.find((d) => d.id === gap.documentId);
        return doc ? [{ ...gap, doc }] : [];
      })
    : [];

  // Count, not just presence -- shown on both the Bid Packages tab badge
  // and folded into reviewIssueCount below, same "something needs your
  // attention" signal every other Review-tab flag already gives.
  const bidPackagesAwaitingReview = currentVersion
    ? currentVersion.bidPackages.filter((p) => p.status === "QUOTE_RECEIVED").length
    : 0;

  const reviewIssueCount = riskFlags.length + categoryAudit.issues.length + coverageGapsWithDocs.length + bidPackagesAwaitingReview;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Estimate — ${estimate.opportunity.showName}`}
        action={
          <Link href={`/opportunities/${estimate.opportunity.id}`} className="text-sm text-neutral-500 hover:text-neutral-900">
            ← {estimate.opportunity.company.name}
          </Link>
        }
      />

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Details
        </h2>
        {estimate.archivedAt && (
          <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3">
            <p className="text-sm text-amber-900">
              Archived {estimate.archivedAt.toLocaleDateString()} — hidden from the Opportunity&apos;s active
              Estimates list and read-only. Everything here (documents, line items, proposals) stays viewable;
              unarchive to resume editing.
            </p>
            <form action={unarchiveEstimateWithIds}>
              <Button variant="secondary">Unarchive</Button>
            </form>
          </div>
        )}
        <form action={updateEstimateDetailsWithId} className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Field
              label="Budget ($)"
              name="budget"
              type="number"
              defaultValue={estimate.budget?.toString() ?? ""}
            />
            <SelectField
              label="Tax jurisdiction"
              name="taxRateId"
              defaultValue={estimate.taxRateId ?? ""}
              options={[
                { value: "", label: "— none —" },
                ...taxRates.map((t) => ({ value: t.id, label: taxRateOptionLabel(t) })),
              ]}
            />
          </div>
          {!estimate.archivedAt && (
            <div>
              <Button>Save details</Button>
            </div>
          )}
        </form>
        {!estimate.archivedAt && (
          <ConfirmForm
            action={archiveEstimateWithIds}
            confirmMessage="Archive this estimate? It's hidden from the Opportunity's active Estimates list and becomes read-only, but stays fully viewable under Archived estimates and can be unarchived later."
            className="mt-4 border-t border-neutral-200 pt-4"
          >
            <Button variant="danger">Archive estimate</Button>
          </ConfirmForm>
        )}
      </Card>

      {!currentVersion ? (
        <Card className="p-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Version 1
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            No estimate version yet. Start one to begin adding sections and line items.
          </p>
          <form action={createFirstVersionWithId}>
            <Button>Start version 1</Button>
          </form>
        </Card>
      ) : (
        <>
          <VersionSummaryBar
            estimateId={estimate.id}
            version={currentVersion}
            proposalTemplates={proposalTemplates}
            categories={categories}
          />

          <Suspense fallback={null}>
            <Tabs
              tabs={[
                { id: "line-items", label: "Line Items" },
                { id: "options", label: "Options (alternates)", count: currentVersion.options.length },
                { id: "bid-packages", label: "Bid Packages", count: currentVersion.bidPackages.length },
                { id: "documents", label: "Documents" },
                { id: "type-totals", label: "Type Totals" },
                { id: "review", label: "Review", count: reviewIssueCount },
                { id: "proposal", label: "Proposal & Approval" },
                { id: "cut-list", label: "Cut List" },
                { id: "history", label: "History", count: vendorMatchApplyLog.length },
              ]}
              content={{
                "line-items": (
                  <LineItemsTab
                    estimateId={estimate.id}
                    opportunityId={estimate.opportunityId}
                    version={currentVersion}
                    categories={categories}
                    categoryMarginOverrides={categoryMarginOverrides}
                    categoryOptions={categoryOptions}
                    laborRates={laborRateOptions}
                    attachments={attachments}
                    users={users}
                    confirmedCount={confirmedCount}
                  />
                ),
                options: (
                  <OptionsTab
                    estimateId={estimate.id}
                    opportunityId={estimate.opportunityId}
                    version={currentVersion}
                    laborRates={laborRateOptions}
                    categoryOptions={categoryOptions}
                  />
                ),
                "bid-packages": (
                  <BidPackagesTab
                    estimateId={estimate.id}
                    opportunityId={estimate.opportunity.id}
                    version={currentVersion}
                    vendorQuoteDocuments={vendorQuoteDocuments}
                    appliedLineItemIds={appliedLineItemIds}
                    staleMatchCount={staleMatchCount}
                  />
                ),
                documents: (
                  <DocumentsTab
                    estimateId={estimate.id}
                    opportunityId={estimate.opportunity.id}
                    users={users}
                    attachments={attachments}
                    addAttachmentAction={addAttachmentWithId}
                    canImport={canImport}
                    buildEstimateAction={buildEstimateWithIds}
                    buildResult={buildResult}
                    pricingScheduleDocuments={pricingScheduleDocuments.map((d) => ({
                      id: d.id,
                      filename: d.filename,
                      alreadyImported: importedPricingScheduleDocumentIds.has(d.id),
                    }))}
                    previewImportAction={previewImportWithId}
                    importDocumentId={importDocumentId}
                    importPreview={importPreview}
                    mirrorDocuments={mirrorDocuments}
                    currentVersion={currentVersion}
                    scopeDocuments={scopeDocuments}
                    proposeScopeItemsAction={proposeScopeItemsWithId}
                    proposeDocumentId={proposeDocumentId}
                    proposeDocument={proposeDocument ?? null}
                    proposedItems={proposedItems}
                    proposeCatalog={proposeCatalog}
                    estimateNameById={estimateNameById}
                    cadDocuments={cadDocuments}
                    reconcilePullSheetAction={reconcilePullSheetWithId}
                    reconcileResult={reconcileResult}
                    previewPullSheetEnrichmentAction={previewPullSheetEnrichmentWithIds}
                    applyPullSheetEnrichmentAction={applyPullSheetEnrichmentWithIds}
                    enrichCadDocumentId={enrichCadDocumentId}
                    enrichResult={enrichResult}
                    enrichApplied={enrichApplied}
                  />
                ),
                "type-totals": <TypeTotalsTab version={currentVersion} categories={categories} />,
                review: (
                  <ReviewTab
                    estimateId={estimate.id}
                    opportunityId={estimate.opportunityId}
                    riskFlags={riskFlags}
                    categoryAudit={categoryAudit}
                    currentVersion={currentVersion}
                    scopeDocuments={scopeDocuments}
                    runCoverageAnalysisAction={runCoverageAnalysisWithIds}
                    coverageAnalysis={coverageAnalysis}
                    coverageGapsWithDocs={coverageGapsWithDocs}
                    recategorized={recategorized}
                    recategorizeChecked={recategorizeChecked}
                    reconciliationDocuments={pricingScheduleDocuments.map((d) => ({ id: d.id, filename: d.filename }))}
                    runReconciliationAction={currentVersion ? runClientTemplateReconciliationAction.bind(null, estimate.id) : null}
                    reconciliation={reconciliation}
                  />
                ),
                proposal: (
                  <ProposalApprovalTab
                    estimateId={estimate.id}
                    version={currentVersion}
                    users={users}
                    proposalTemplates={proposalTemplates}
                    olderVersions={olderVersions}
                  />
                ),
                "cut-list": <CutListTab estimateId={estimate.id} versionId={currentVersion.id} />,
                history: (
                  <HistoryTab
                    estimateId={estimate.id}
                    isLocked={currentVersion.isLocked}
                    log={vendorMatchApplyLog}
                    auditLog={lineItemAuditLog}
                  />
                ),
              }}
            />
          </Suspense>
        </>
      )}

      <ChatWidget
        opportunityId={estimate.opportunityId}
        opportunityName={estimate.opportunity.showName}
        initialMessages={chatMessages.map((m) => ({
          id: m.id,
          role: m.role,
          content: linkifyMentions(m.content, estimate.opportunityId, allOpportunityDocuments, citableLineItems, citableQuotes),
        }))}
      />
    </div>
  );
}

type VersionWithSections = Prisma.EstimateVersionGetPayload<{
  include: {
    sections: {
      include: {
        lineItems: {
          include: {
            costActuals: true;
            document: { select: { id: true; mimeType: true; filename: true } };
            bidPackage: { select: { id: true; name: true } };
          };
        };
      };
    };
    options: {
      include: {
        sections: {
          include: {
            lineItems: {
              include: {
                costActuals: true;
                document: { select: { id: true; mimeType: true; filename: true } };
                bidPackage: { select: { id: true; name: true } };
              };
            };
          };
        };
      };
    };
    bidPackages: {
      include: {
        lineItems: {
          select: {
            id: true;
            description: true;
            category: true;
            qty: true;
            unit: true;
            unitCost: true;
            totalCost: true;
            documentId: true;
            section: { select: { name: true; groupLabel: true } };
          };
        };
        documents: true;
      };
    };
    approvedBy: true;
    proposals: true;
    changeOrdersAsBase: true;
  };
}>;

// The always-visible header/summary -- title, lock status, totals -- kept
// outside the tab system entirely (not one of the five tabs' content)
// since it's context relevant regardless of which tab is open, the same
// reasoning the design note gave for keeping it out: "context, not a
// section."
function VersionSummaryBar({
  estimateId,
  version,
  proposalTemplates,
  categories,
}: {
  estimateId: string;
  version: VersionWithSections;
  proposalTemplates: { id: string; name: string }[];
  categories: Category[];
}) {
  const lockVersionWithIds = lockVersionAction.bind(null, estimateId, version.id);
  const createNewVersionWithIds = createNewVersionAction.bind(null, estimateId, version.id);

  // Which top-level categories the Preview PDF modal's reorder/hide-
  // pricing/summary controls should list -- matching preview-pdf/
  // route.ts's own isDraft:false / optionId:null discipline exactly (in-
  // memory here against the same version.sections the rest of this page
  // already loaded, rather than a second DB round trip), so the modal
  // never offers a category the PDF wouldn't actually render. Only
  // top-level categories are independently reorderable/toggleable in the
  // PDF itself (a child category always renders nested under its parent
  // -- see proposal-pdf.tsx's own render loop), so that's all this lists.
  const previewSections = version.sections
    .filter((s) => s.optionId === null)
    .map((s) => ({
      name: s.name,
      groupLabel: s.groupLabel,
      buildType: s.buildType,
      lineItems: s.lineItems.filter((li) => !li.isDraft),
    }));
  const previewTopLevel = buildTopLevelCategoryViews(aggregateByCategory(previewSections, categories), categories);
  const categoryNameToId = new Map(categories.map((c) => [c.name, c.id]));
  const categoriesWithItems = previewTopLevel
    .map((c) => {
      const id = categoryNameToId.get(c.name);
      return id ? { id, name: c.name } : null;
    })
    .filter((c): c is { id: string; name: string } => c !== null);

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Version {version.versionNumber} {version.isLocked ? "· locked" : "· editing"}
        </h2>
        {version.isLocked && !version.isApproved && (
          <form action={createNewVersionWithIds}>
            <Button variant="secondary">Create new version</Button>
          </form>
        )}
        {!version.isLocked && (
          <form action={lockVersionWithIds}>
            <Button variant="secondary">Lock version</Button>
          </form>
        )}
      </div>

      <div className="mb-4 grid grid-cols-3 gap-4 rounded-md bg-neutral-50 p-4 text-sm">
        <div>
          <div className="text-neutral-500">Total cost</div>
          <div className="text-lg font-semibold">{money(version.totalCost)}</div>
        </div>
        <div>
          <div className="text-neutral-500">Grand total</div>
          <div className="text-lg font-semibold text-brand-navy">{money(version.grandTotal)}</div>
        </div>
        <div>
          <div className="text-neutral-500">Gross margin</div>
          <div className="text-lg font-semibold">{version.grossMarginPct.toFixed(1)}%</div>
          {/* grossMarginPct is derived entirely from marginTargetPct (see
              estimate-service.ts's computeMarginGrossUp) -- 0.0% at its
              default doesn't mean cost and price have diverged badly, it
              means no target has been entered yet, so grandTotal still
              equals totalCost exactly. */}
          {version.marginTargetPct.toNumber() === 0 && (
            <div className="mt-0.5 text-xs text-neutral-400">No margin target set -- see Line Items tab</div>
          )}
        </div>
      </div>

      {/* Kept always visible (not inside Proposal & Approval) on purpose --
          this deliberately works "anytime, even while this version is
          still unlocked and changing" (see the form's own copy below), an
          editing-time check, not a final-approval one. A user reported it
          missing after the tab restructuring specifically because it had
          been moved behind a tab click; this is the fix, not a new
          feature. */}
      <div className="rounded-md border border-dashed border-neutral-300 p-4">
        <p className="mb-3 text-sm text-neutral-500">
          Check the branded PDF format anytime, even while this version is still unlocked and
          changing — this doesn&apos;t create a real Proposal record, just renders current numbers.
        </p>
        {proposalTemplates.length === 0 ? (
          <Notice
            message="Previewing a PDF needs a branded template, and there are no templates yet."
            actionHref="/catalog/proposal-templates/new"
            actionLabel="Add a template"
          />
        ) : (
          <ProposalPreviewModal
            estimateId={estimateId}
            versionId={version.id}
            proposalTemplates={proposalTemplates}
            categories={categoriesWithItems}
          />
        )}
      </div>
    </Card>
  );
}

// Real XLSX pricing-schedule imports can list one row per physical booth
// instance (113 rows for one section, on the real Super Bowl 2026 job) --
// unscannable as a flat table. Above this row count, group rows under
// collapsible per-booth sub-tables and show a rollup of the materials
// that repeat most, without touching any LineItem data, citations, or
// confirm state.
const BOOTH_GROUP_ROW_THRESHOLD = 20;
const BOOTH_START_PATTERN = /complete booth build/i;

type SectionLineItem = VersionWithSections["sections"][number]["lineItems"][number];

// Splits a section's rows into booth-instance groups wherever a row's
// description marks the start of a new booth ("Complete Booth Build...").
// Returns null when no such marker is present -- the caller then falls
// back to today's flat table, so a booth-split miss never hides or
// reorders real data.
function groupLineItemsByBoothInstance(
  lineItems: SectionLineItem[],
): { label: string; items: SectionLineItem[] }[] | null {
  if (!lineItems.some((li) => BOOTH_START_PATTERN.test(li.description))) return null;

  const groups: { label: string; items: SectionLineItem[] }[] = [];
  const isBoothInstance: boolean[] = [];
  for (const li of lineItems) {
    if (BOOTH_START_PATTERN.test(li.description)) {
      groups.push({ label: li.description, items: [li] });
      isBoothInstance.push(true);
    } else if (groups.length === 0) {
      groups.push({ label: "Other items", items: [li] });
      isBoothInstance.push(false);
    } else {
      groups[groups.length - 1].items.push(li);
    }
  }

  // Real pricing schedules sometimes list two physically-identical booths
  // back to back with the exact same description text (e.g. two "Camera
  // Booth" rows filed under the same numbered section, seen on a real
  // Super Bowl 2026 job -- different unit costs, identical wording). An
  // ordinal suffix is the only way to tell the groups apart in the UI,
  // since the source text itself doesn't distinguish them.
  const boothInstanceTotal = isBoothInstance.filter(Boolean).length;
  if (boothInstanceTotal > 1) {
    let seen = 0;
    groups.forEach((g, i) => {
      if (!isBoothInstance[i]) return;
      seen += 1;
      g.label = `${g.label} — Booth ${seen} of ${boothInstanceTotal}`;
    });
  }
  return groups;
}

// Read-only scanning aid: which descriptions repeat most across a dense
// section, and their combined quantity -- computed at render time from
// data already on the page, never persisted or used for pricing.
function summarizeRepeatedDescriptions(lineItems: SectionLineItem[]) {
  const byDescription = new Map<string, { count: number; qtyTotal: Prisma.Decimal }>();
  for (const li of lineItems) {
    const existing = byDescription.get(li.description);
    if (existing) {
      existing.count += 1;
      existing.qtyTotal = existing.qtyTotal.plus(li.qty);
    } else {
      byDescription.set(li.description, { count: 1, qtyTotal: li.qty });
    }
  }
  return [...byDescription.entries()]
    .filter(([, v]) => v.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 6)
    .map(([description, v]) => ({ description, count: v.count, qtyTotal: v.qtyTotal.toString() }));
}

function LineItemsTable({
  lineItems,
  version,
  estimateId,
  opportunityId,
  laborRates,
  categoryOptions,
}: {
  lineItems: SectionLineItem[];
  version: VersionWithSections;
  estimateId: string;
  opportunityId: string;
  laborRates: LaborRateOption[];
  categoryOptions: { value: string; label: string }[];
}) {
  return (
    <table className="w-full min-w-[38rem] text-sm">
      <thead>
        <tr className="text-left text-neutral-500">
          <th className="px-2 pb-1.5 font-normal">Description</th>
          <th className="px-2 pb-1.5 font-normal">Dept</th>
          <th className="px-2 pb-1.5 font-normal">Type</th>
          <th className="px-2 pb-1.5 text-right font-normal">Qty</th>
          <th className="px-2 pb-1.5 text-right font-normal">Unit cost</th>
          <th className="px-2 pb-1.5 text-right font-normal">Est. total</th>
          {version.isLocked && (
            <>
              <th className="px-2 pb-1.5 text-right font-normal">Actual</th>
              <th className="px-2 pb-1.5 text-right font-normal">Variance</th>
            </>
          )}
          {!version.isLocked && <th className="px-2 pb-1.5"></th>}
        </tr>
      </thead>
      <tbody>
        {lineItems.map((li, index) => {
          const deleteWithIds = deleteLineItemAction.bind(null, estimateId, li.id);
          const confirmWithIds = confirmDraftLineItemAction.bind(null, estimateId, li.id);
          const updateWithIds = updateLineItemAction.bind(null, estimateId, version.id, li.id);
          const moveUpWithIds = moveLineItemAction.bind(null, estimateId, li.id, "up");
          const moveDownWithIds = moveLineItemAction.bind(null, estimateId, li.id, "down");
          const actualCost = version.isLocked ? computeActualTotal(li.costActuals) : null;
          const variance = actualCost !== null ? actualCost.minus(li.totalCost) : null;
          // The check-and-balance: only real when sourceQuote is present
          // (a pricing-schedule row's own cell text, or an AI-proposed
          // item's verified quote -- never asked of the model as a page
          // number, always computed by actually finding the quote in the
          // source, see pricing-import-service.ts / scope-line-item-service.ts).
          // Absent for a manually added row or one imported before this
          // existed -- no silent/fake link either way.
          const sourceHref =
            li.document && li.sourceQuote
              ? citationHref(
                  opportunityId,
                  li.document,
                  { sourceQuote: li.sourceQuote, pageNumber: li.sourcePageNumber },
                  `/estimates/${estimateId}#line-item-${li.id}`,
                )
              : null;
          return (
            <LineItemRow
              key={li.id}
              id={li.id}
              description={li.description}
              positionCode={li.positionCode}
              isDraft={li.isDraft}
              sourceHref={sourceHref}
              department={li.department ?? ""}
              lineType={li.lineType}
              category={li.category ?? ""}
              qty={li.qty.toString()}
              unit={li.unit ?? ""}
              unitCost={li.unitCost.toString()}
              totalCostDisplay={money(li.totalCost)}
              isClientOwned={li.isClientOwned}
              usageTag={li.usageTag ?? ""}
              isLocked={version.isLocked}
              actualCostDisplay={actualCost !== null ? money(actualCost) : null}
              varianceDisplay={variance !== null ? money(variance) : null}
              varianceTone={variance === null ? null : variance.isPositive() ? "up" : variance.isNegative() ? "down" : "flat"}
              isFirst={index === 0}
              isLast={index === lineItems.length - 1}
              lineTypeOptions={LINE_TYPE_OPTIONS}
              usageTagOptions={LINE_ITEM_USAGE_TAG_OPTIONS}
              categoryOptions={categoryOptions}
              laborRates={laborRates}
              bidPackageName={li.bidPackage?.name ?? null}
              deleteAction={deleteWithIds}
              confirmAction={confirmWithIds}
              updateAction={updateWithIds}
              moveUpAction={moveUpWithIds}
              moveDownAction={moveDownWithIds}
            />
          );
        })}
      </tbody>
    </table>
  );
}

// One section's worth of line items, rendered wherever it shows up (used
// both per-category in the category board below, and inside an Option).
// Booth-grouping/rollup, the Actual-cost entry list, and Add Line Item
// are all unchanged from before this file had tabs -- only where this
// gets called from changed.
function SectionLineItemsBlock({
  lineItems,
  version,
  estimateId,
  opportunityId,
  laborRates,
  categoryOptions,
}: {
  lineItems: SectionLineItem[];
  version: VersionWithSections;
  estimateId: string;
  opportunityId: string;
  laborRates: LaborRateOption[];
  categoryOptions: { value: string; label: string }[];
}) {
  if (lineItems.length === 0) return null;
  const boothGroups =
    lineItems.length > BOOTH_GROUP_ROW_THRESHOLD ? groupLineItemsByBoothInstance(lineItems) : null;

  if (!boothGroups) {
    return (
      <div className="mb-1 overflow-x-auto rounded-md border border-neutral-200">
        <LineItemsTable
          lineItems={lineItems}
          version={version}
          estimateId={estimateId}
          opportunityId={opportunityId}
          laborRates={laborRates}
          categoryOptions={categoryOptions}
        />
      </div>
    );
  }

  const rollup = summarizeRepeatedDescriptions(lineItems);
  return (
    <div className="mb-1 flex flex-col gap-3">
      {rollup.length > 0 && (
        <div className="flex flex-wrap gap-2 rounded-md bg-neutral-50 p-3 text-xs text-neutral-600">
          {rollup.map((r) => (
            <span key={r.description} className="rounded-full border border-neutral-200 bg-white px-2 py-1">
              {r.description} — {r.count} instances, {r.qtyTotal} total
            </span>
          ))}
        </div>
      )}
      {boothGroups.map((group, i) => (
        <details key={i} className="rounded-md border border-neutral-200">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium marker:content-none [&::-webkit-details-marker]:hidden">
            {group.label}
            <span className="text-xs font-normal text-neutral-400">({group.items.length} items)</span>
          </summary>
          <div className="overflow-x-auto border-t border-neutral-200">
            <LineItemsTable
              lineItems={group.items}
              version={version}
              estimateId={estimateId}
              opportunityId={opportunityId}
              laborRates={laborRates}
              categoryOptions={categoryOptions}
            />
          </div>
        </details>
      ))}
    </div>
  );
}

// The "Line Items" tab: the category board itself (Excel-sheet-tab-style
// navigation across Labor/Structure/Furniture/...), plus Add section, the
// one structural control that still applies across every category. Options
// (alternates) used to be a card stacked below this instead -- it's now
// its own top-level tab (see OptionsTab) so it's a peer of Documents/
// Review/Proposal/Cut List rather than a visually different secondary
// block bolted onto Line Items. Section reordering (the old ▲▼ next to a
// section heading) is deliberately dropped from this pass rather than
// half-ported into a category-filtered view where "up" wouldn't reliably
// mean what it used to -- a real follow-up, not an oversight.
function LineItemsTab({
  estimateId,
  opportunityId,
  version,
  categories,
  categoryMarginOverrides,
  categoryOptions,
  laborRates,
  attachments,
  users,
  confirmedCount,
}: {
  estimateId: string;
  opportunityId: string;
  version: VersionWithSections;
  categories: { id: string; name: string; key: string; parentId: string | null }[];
  categoryMarginOverrides: { categoryId: string; marginPct: Prisma.Decimal }[];
  categoryOptions: { value: string; label: string }[];
  laborRates: LaborRateOption[];
  attachments: { id: string; fileRef: string }[];
  users: { id: string; name: string }[];
  confirmedCount: number | null;
}) {
  const buckets = bucketLineItemsByCategory(version.sections, categories);
  const primaryTabs = groupPrimaryCategoryTabs(buckets, categories);
  const marginOverrideByCategoryId = new Map(categoryMarginOverrides.map((o) => [o.categoryId, o.marginPct]));
  const addSectionWithIds = addSectionAction.bind(null, estimateId, version.id);
  const draftCount = version.sections.flatMap((s) => s.lineItems).filter((li) => li.isDraft).length;

  // Every booth/component-linked section (EstimateSection.groupLabel).
  // Most jobs have none of these. A booth's tag (EstimateSection.
  // buildType, set once per booth via the tagging card below -- every
  // section sharing one groupLabel always shares the same buildType,
  // updateSectionBuildTypeAction sets them together) only supplies
  // Method (Rental/Purchase/Custom Fabricated); each item still resolves
  // its own Type independently, same as resolveEffectiveCategory. So a
  // single booth's content can spread across several category tabs
  // (Structure, Audio/Visual, ...) instead of one swallowing the rest --
  // see boothGroupsByCategoryForEditing. allBoothGroups (the flat,
  // pre-split variant) exists only to enumerate real booth labels for the
  // untagged-booth prompt below.
  const allBoothGroups = groupBoothLineItemsForEditing(version.sections);
  const buildTypeByBoothLabel = new Map<string, SectionBuildType | null>();
  for (const section of version.sections) {
    if (section.groupLabel && !buildTypeByBoothLabel.has(section.groupLabel)) {
      buildTypeByBoothLabel.set(section.groupLabel, section.buildType);
    }
  }
  const untaggedBoothLabels = allBoothGroups
    .map((g) => g.boothLabel)
    .filter((label) => !buildTypeByBoothLabel.get(label));
  const boothGroupsByCategoryName = boothGroupsByCategoryForEditing(version.sections, categories);

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        {confirmedCount !== null && (
          <p className="mb-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
            Confirmed {confirmedCount} draft line item{confirmedCount === 1 ? "" : "s"} -- now counted in the version total.
          </p>
        )}
        {version.isLocked ? (
          <VarianceByDepartment sections={version.sections} />
        ) : (
          <div className="mb-6 flex flex-wrap items-end gap-3">
            <form action={updateMarginTargetAction.bind(null, estimateId, version.id)} className="flex items-end gap-3">
              <div className="w-40">
                <Field
                  label="Margin target (%)"
                  name="marginTargetPct"
                  type="number"
                  defaultValue={version.marginTargetPct.toString()}
                  required
                />
              </div>
              <Button variant="secondary">Update margin</Button>
            </form>
            {draftCount > 0 && (
              <form
                action={confirmAllDraftLineItemsAction.bind(null, estimateId, version.id)}
                title="Marks every draft line item in this version as human-reviewed and priced -- review pricing first, this can't be undone in bulk."
              >
                <Button variant="secondary">
                  Confirm all {draftCount} draft line item{draftCount === 1 ? "" : "s"}
                </Button>
              </form>
            )}
          </div>
        )}

        {!version.isLocked && (
          <details className="mb-6 rounded-md border border-neutral-200">
            <summary className="cursor-pointer list-none px-4 py-2.5 text-sm font-medium marker:content-none [&::-webkit-details-marker]:hidden">
              Category margins
              <span className="ml-2 font-normal text-neutral-500">
                (Target: {version.marginTargetPct.toString()}% &middot; Blended actual: {version.grossMarginPct.toFixed(1)}%)
              </span>
            </summary>
            <div className="flex flex-col gap-2 border-t border-neutral-200 p-4">
              <p className="mb-1 text-xs text-neutral-500">
                Leave blank to price a Type at the margin target above. An override only applies to that Type -- everything
                else keeps inheriting the target until it gets its own override.
              </p>
              {primaryTabs.map((tab) => {
                const override = marginOverrideByCategoryId.get(tab.id);
                return (
                  <div key={tab.id} className="flex flex-wrap items-center gap-2">
                    <span className="w-40 text-sm text-neutral-700">{tab.label}</span>
                    <form
                      action={setCategoryMarginOverrideAction.bind(null, estimateId, version.id, tab.id)}
                      className="flex items-center gap-2"
                    >
                      <div className="w-24">
                        <Field
                          label=""
                          name="marginPct"
                          type="number"
                          defaultValue={override?.toString()}
                          placeholder={`${version.marginTargetPct.toString()}%`}
                        />
                      </div>
                      <Button variant="secondary" type="submit">
                        Set
                      </Button>
                    </form>
                    {override && (
                      <form action={clearCategoryMarginOverrideAction.bind(null, estimateId, version.id, tab.id)}>
                        <button type="submit" className="text-xs text-neutral-500 underline hover:text-neutral-700">
                          Reset to target
                        </button>
                      </form>
                    )}
                  </div>
                );
              })}
            </div>
          </details>
        )}

        {untaggedBoothLabels.length > 0 && (
          <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4">
            <h3 className="mb-1 text-sm font-semibold text-amber-900">
              Components needing a Rental/Purchase/Custom Fabricated tag
            </h3>
            <p className="mb-3 text-xs text-amber-800">
              Tagging a component sets how it&apos;s being acquired -- each item still lands under its own real
              category (Structure, Audio/Visual, Furniture, ...), just as e.g. &quot;Structure - Rental&quot;
              instead of plain &quot;Structure&quot;, grouped by component within that category.
            </p>
            <ul className="flex flex-col gap-2">
              {untaggedBoothLabels.map((boothLabel) => (
                <li key={boothLabel} className="flex flex-wrap items-center gap-2">
                  <form
                    action={updateSectionBuildTypeAction.bind(null, estimateId, version.id, boothLabel)}
                    className="flex items-center gap-2"
                  >
                    <span className="text-sm font-medium text-amber-900">{boothLabel}</span>
                    <SelectField
                      label=""
                      name="buildType"
                      options={[
                        { value: "RENTAL", label: "Rental" },
                        { value: "PURCHASE", label: "Purchase" },
                        { value: "CUSTOM_BUILD", label: "Custom Fabricated" },
                      ]}
                    />
                    <Button variant="secondary" type="submit">
                      Tag
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        )}

        <BidPackageSelectionProvider>
          <Tabs
            paramName="category"
            tabs={primaryTabs.map((t) => ({ id: t.id, label: t.label, count: t.totalItems }))}
            content={Object.fromEntries(
              primaryTabs.map((tab) => [
                tab.id,
                <PrimaryCategoryTabContent
                  key={tab.id}
                  tab={tab}
                  version={version}
                  estimateId={estimateId}
                  opportunityId={opportunityId}
                  laborRates={laborRates}
                  categoryOptions={categoryOptions}
                  attachments={attachments}
                  users={users}
                  boothGroupsByCategoryName={boothGroupsByCategoryName}
                  categories={categories}
                  marginOverrideByCategoryId={marginOverrideByCategoryId}
                />,
              ]),
            )}
          />
          {/* One shared sticky wrapper, not one per bar -- position: sticky
              doesn't reserve stacking space between independently-sticky
              siblings, so two bars each pinned to their own `bottom-4`
              paint directly on top of each other instead of stacking
              (confirmed live: only the second one was ever visible). */}
          <div className="sticky bottom-4 z-10 mt-4 flex flex-col gap-3">
            <CreateBidPackageBar createBidPackage={createBidPackageAction.bind(null, estimateId, version.id)} />
            <MoveSelectedItemsBar
              moveSelected={bulkMoveLineItemsCategoryAction.bind(null, estimateId, version.id)}
              categoryOptions={categoryOptions.filter((o) => o.value !== "")}
            />
          </div>
        </BidPackageSelectionProvider>

        {!version.isLocked && (
          <form action={addSectionWithIds} className="mt-6 flex items-end gap-3 border-t border-neutral-200 pt-4">
            <div className="flex-1">
              <Field label="New section name" name="name" placeholder="e.g. COMPONENT 1" required />
            </div>
            <div className="w-48">
              <SelectField label="Type" name="sectionType" defaultValue="COMPONENT" options={SECTION_TYPE_OPTIONS} />
            </div>
            <Button variant="secondary">Add section</Button>
          </form>
        )}
      </Card>
    </div>
  );
}

// Promoted out of LineItemsTab into its own top-level tab -- see this
// file's estimate-page Tabs call. Options (alternates) is a peer tool
// (like Documents/Review/Cut List), not a secondary block that belongs
// visually subordinate to the line-items category board.
function OptionsTab({
  estimateId,
  opportunityId,
  version,
  laborRates,
  categoryOptions,
}: {
  estimateId: string;
  opportunityId: string;
  version: VersionWithSections;
  laborRates: LaborRateOption[];
  categoryOptions: { value: string; label: string }[];
}) {
  const addOptionWithIds = addOptionAction.bind(null, estimateId, version.id);

  return (
    <Card className="p-6">
      <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Options (alternates)
      </h3>
      {/* Confirmed by reading both PDF-rendering paths (preview-pdf/route.ts
          and proposals/[id]/pdf/route.ts) -- both scope their sections query
          to optionId: null unconditionally, and there's no "promote to base
          version" action anywhere in the codebase. So this is a hard,
          permanent fact about today's behavior, not a caveat. */}
      <p className="mb-4 text-xs text-neutral-400">
        Internal comparison only -- an option&apos;s line items never appear on the client-facing proposal PDF.
      </p>
      {version.options.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {version.isLocked ? "No alternate options on this version." : "No alternate options yet."}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {version.options.map((option) => (
            <OptionCard
              key={option.id}
              estimateId={estimateId}
              opportunityId={opportunityId}
              version={version}
              option={option}
              isLocked={version.isLocked}
              laborRates={laborRates}
              categoryOptions={categoryOptions}
            />
          ))}
        </div>
      )}
      {!version.isLocked && (
        <form action={addOptionWithIds} className="mt-6 flex items-end gap-3 border-t border-neutral-200 pt-4">
          <div className="flex-1">
            <Field label="New option name" name="name" placeholder="e.g. Option 1: Upgraded flooring" required />
          </div>
          <Button variant="secondary">Add option</Button>
        </form>
      )}
    </Card>
  );
}

// Groups an outsourced-to-a-vendor subset of this version's line items
// (created from the Line Items tab's checkbox/CreateBidPackageBar --
// see bid-package-selection.tsx) and, once a vendor's quote is attached
// and its priced lines extracted, shows a match/review table pairing
// the vendor's own lines against this package's line items --
// vendor-match-ai-service.ts's matchVendorQuoteLinesWithAi, run once in
// the background (bid-package-actions.ts's runVendorExtractionAndMatch)
// and persisted on BidPackage.matchResult, not recomputed on every
// render (see bid-package-actions.ts's own header comment on why
// "applied" is derived from documentId equality instead of a decision
// log).
function BidPackagesTab({
  estimateId,
  opportunityId,
  version,
  vendorQuoteDocuments,
  appliedLineItemIds,
  staleMatchCount,
}: {
  estimateId: string;
  opportunityId: string;
  version: VersionWithSections;
  vendorQuoteDocuments: { id: string; filename: string }[];
  appliedLineItemIds: Set<string>;
  staleMatchCount: number;
}) {
  // Every line item on the CURRENT version, not just ones already added
  // to a given bid package -- the "Matched to" dropdown offers this full
  // set (see bid-package-actions.ts's runVendorExtractionAndMatch and
  // applyVendorMatchAction for why: the version, built from the client's
  // own source-of-truth spreadsheet import, is almost always far bigger
  // than the handful of items originally checked into one bid package).
  const allLineItems = version.sections.flatMap((s) =>
    s.lineItems.map((li) => ({
      id: li.id,
      description: li.description,
      sectionLabel: s.groupLabel ?? s.name,
      documentId: li.documentId,
      bidPackageId: li.bidPackageId,
      unitCost: li.unitCost.toNumber(),
      qty: li.qty.toNumber(),
    })),
  );
  return (
    <div className="flex flex-col gap-6">
      {version.bidPackages.length === 0 ? (
        <Card className="p-6">
          <p className="text-sm text-neutral-500">
            No bid packages yet. In the Line Items tab, check off the items you want a vendor to bid on (any
            category, any section) and name the package at the bottom of the screen.
          </p>
        </Card>
      ) : (
        version.bidPackages.map((bidPackage) => (
          <BidPackageCard
            key={bidPackage.id}
            estimateId={estimateId}
            opportunityId={opportunityId}
            versionId={version.id}
            bidPackage={bidPackage}
            vendorQuoteDocuments={vendorQuoteDocuments}
            allLineItems={allLineItems}
            appliedLineItemIds={appliedLineItemIds}
            staleMatchCount={staleMatchCount}
          />
        ))
      )}
    </div>
  );
}

const BID_PACKAGE_STATUS_LABELS: Record<string, string> = {
  AWAITING_QUOTE: "Awaiting quote",
  QUOTE_RECEIVED: "Quote received — needs review",
  REVIEWED: "Reviewed",
};

// matchVendorQuoteLinesWithAi's own confidence, surfaced so a reviewer
// can tell an assignment it's confident in from one it flagged as a
// guess worth double-checking, instead of every suggestion looking
// equally authoritative.
const CONFIDENCE_BADGE_CLASS: Record<string, string> = {
  high: "bg-green-50 text-green-700",
  medium: "bg-amber-50 text-amber-700",
  low: "bg-red-50 text-red-700",
};

// Both lists below sort largest-dollar-drift-first (see priceDrift's own
// comment), so what's hidden behind the "Show N more" disclosure is
// always the least-changed, lowest-priority tail -- never the thing a
// reviewer actually needs to see first. Confirmed live against a real
// 44-group/242-line package: without a cap, this tab was an unbroken
// scroll of near-identical "quote revised" text.
const BULK_GROUP_VISIBLE_COUNT = 15;
const MATCH_ROW_VISIBLE_COUNT = 25;

// proposeVendorQuoteLineItems extracts qty/unit for every vendor line but
// the match review table previously showed only the bare description --
// a reviewer had no way to see "3 EA" vs "1 EA" without opening the
// source document.
function vendorLineQtyUnit(vendorLine: { qty: number | null; unit: string | null }): string | null {
  if (vendorLine.qty != null && vendorLine.unit) return `${vendorLine.qty} ${vendorLine.unit}`;
  if (vendorLine.qty != null) return `Qty ${vendorLine.qty}`;
  return vendorLine.unit || null;
}

function BidPackageCard({
  estimateId,
  opportunityId,
  versionId,
  bidPackage,
  vendorQuoteDocuments,
  allLineItems,
  appliedLineItemIds,
  staleMatchCount,
}: {
  estimateId: string;
  opportunityId: string;
  versionId: string;
  bidPackage: VersionWithSections["bidPackages"][number];
  vendorQuoteDocuments: { id: string; filename: string }[];
  allLineItems: {
    id: string;
    description: string;
    sectionLabel: string | null;
    documentId: string | null;
    bidPackageId: string | null;
    unitCost: number;
    qty: number;
  }[];
  appliedLineItemIds: Set<string>;
  staleMatchCount: number;
}) {
  const priorAppliedValue = Array.from(appliedLineItemIds).join(",");
  const attachWithIds = attachVendorQuoteDocumentAction.bind(null, estimateId, bidPackage.id);
  const markReviewedWithIds = markBidPackageReviewedAction.bind(null, estimateId, bidPackage.id);
  const quoteDocument = bidPackage.documents[0] ?? null;
  const phase = bidPackage.vendorExtractionPhase;
  const isExtracting = phase === "READING_DOCUMENT" || phase === "EXTRACTING_LINES" || phase === "MATCHING";
  const matches = (bidPackage.matchResult as unknown as VendorLineMatch[] | null) ?? null;
  const proposedSections = (bidPackage.proposedSections as unknown as ProposedVendorSection[] | null) ?? [];
  const matchedLineItemIds = new Set((matches ?? []).flatMap((m) => (m.lineItemId ? [m.lineItemId] : [])));
  // A line item a reviewer manually applied a price to (picking a
  // different row than the algorithm suggested, or resolving one it left
  // unmatched entirely) is just as "covered" as an algorithm-suggested
  // one -- matchedLineItemIds alone would keep flagging it as uncovered
  // forever, even after it has a real price and provenance from this
  // exact quote.
  const unmatchedPackageItems = bidPackage.lineItems.filter(
    (li) => !matchedLineItemIds.has(li.id) && li.documentId !== quoteDocument?.id,
  );

  // Re-extract fully recomputes matchResult from the current state of the
  // document -- a revised vendor quote (different prices, corrected
  // qtys) produces a fresh set of vendor lines every time. Without this,
  // a target already applied from THIS SAME document would just look
  // "applied" forever (documentId still matches) and silently keep its
  // stale price: the row disappears from Match Review, "Apply all N
  // high-confidence" skips it as already-done, and the revised number
  // from the vendor is never surfaced anywhere. Grouped by CONFIRMED
  // target only (m.lineItemId, never suggestedLineItemId) -- a bulk
  // group can have several vendor lines sharing one suggested target
  // where only ONE ever actually won an apply (see resolveVendorLineMatches's
  // dedup comment); the rest are still just proposals, never summed into
  // what's actually on the line item. Grouping by suggestedLineItemId too
  // was tried first and produced a false-positive "drift" on nearly every
  // already-applied row in the package (confirmed live) -- it was
  // comparing the target's real applied price against a fresh sum that
  // included sibling vendor lines nobody had ever applied yet.
  //
  // Compares TOTAL dollars, not a blended $/unit rate -- confirmed live
  // on the real ShowRig package that several targets genuinely do have
  // multiple DIFFERENT vendor lines resolved onto them (e.g. a camera
  // platform's Paint + Guardrail + Handrail, each its own real cost
  // component, not duplicates of each other), each carrying its own
  // natural unit (EA, LF, SF...). Summing their raw qtys into one
  // denominator to get a "$/unit" produces a number with no real meaning
  // once the units being summed don't match each other. Total dollars is
  // always well-defined regardless of unit mix, and it's the number that
  // actually lands on the line item's totalCost.
  const priceDrift = new Map<string, { previousTotal: number; newTotal: number; driftAmount: number }>();
  if (matches && quoteDocument) {
    const byTargetForDrift = new Map<string, VendorLineMatch[]>();
    for (const m of matches) {
      if (!m.lineItemId) continue;
      byTargetForDrift.set(m.lineItemId, [...(byTargetForDrift.get(m.lineItemId) ?? []), m]);
    }
    for (const [targetId, group] of byTargetForDrift) {
      const target = allLineItems.find((li) => li.id === targetId);
      if (!target || target.documentId !== quoteDocument.id) continue;
      const currentTotal = target.unitCost * target.qty;
      const newTotal = group.reduce((sum, m) => sum + m.vendorLine.unitPrice, 0);
      const driftAmount = Math.abs(currentTotal - newTotal);
      if (driftAmount > 0.5) {
        priceDrift.set(targetId, { previousTotal: currentTotal, newTotal, driftAmount });
      }
    }
  }

  // Groups vendor lines that all point at the SAME target -- either
  // already matched (lineItemId) or the AI's pre-dedup suggestion
  // (suggestedLineItemId, see resolveVendorLineMatches's own header
  // comment) -- so a reviewer can apply all of them at once instead of
  // clicking through each one individually. Only worth surfacing when 2+
  // vendor lines actually share a target; a lone match is just the
  // normal per-row Apply flow.
  const bulkGroups: { targetId: string; matchIndices: number[] }[] = (() => {
    if (!matches) return [];
    const byTarget = new Map<string, number[]>();
    matches.forEach((m, i) => {
      const targetId = m.lineItemId ?? m.suggestedLineItemId;
      if (!targetId) return;
      byTarget.set(targetId, [...(byTarget.get(targetId) ?? []), i]);
    });
    return (
      Array.from(byTarget.entries())
        .filter(([, indices]) => indices.length > 1)
        // Once applied, a group is done -- it no longer needs a
        // reviewer's decision, so it's removed from this active
        // suggestions list entirely rather than sitting here permanently
        // with just a "✓ Applied" badge. The real, permanent record of
        // what was applied now lives on the History tab
        // (vendor-match-apply-log-service.ts), not here. A drifted target
        // is the one exception -- see priceDrift's own comment above --
        // it stays visible even though its documentId already matches.
        .filter(
          ([targetId]) =>
            allLineItems.find((li) => li.id === targetId)?.documentId !== quoteDocument?.id ||
            priceDrift.has(targetId),
        )
        .map(([targetId, matchIndices]) => ({ targetId, matchIndices }))
        // Largest dollar change first -- a $2,000 revision and a $5 one
        // used to render in whatever order the AI's own matches array
        // happened to return them, with identical visual weight. Groups
        // with no drift (a brand-new suggestion, never applied before)
        // keep their original relative order, after every drifted one.
        .sort(
          (a, b) => (priceDrift.get(b.targetId)?.driftAmount ?? -1) - (priceDrift.get(a.targetId)?.driftAmount ?? -1),
        )
    );
  })();

  // Once a vendor line is covered by its own bulk-group card above, it
  // shouldn't ALSO render as a standalone row in the flat Match review
  // table below -- confirmed live, on a real 44-group/242-line package
  // this was rendering every one of those 242 lines twice, once grouped
  // and once individually, which is most of why the tab read as an
  // unreadable wall of repeated "quote revised" text.
  const groupedMatchIndices = new Set(bulkGroups.flatMap((g) => g.matchIndices));
  // Same largest-dollar-change-first ordering as bulkGroups above,
  // applied to the flat table's own rows. Drift is only ever keyed by a
  // CONFIRMED lineItemId (see priceDrift's own comment on why
  // suggestedLineItemId never carries drift), so an ungrouped row with
  // only a suggestedLineItemId sorts as zero drift, same as a brand-new
  // suggestion with no history to compare against.
  const matchIndicesSorted = matches
    ? matches
        .map((_, i) => i)
        .sort((a, b) => {
          const aId = matches[a].lineItemId;
          const bId = matches[b].lineItemId;
          const aDrift = aId ? (priceDrift.get(aId)?.driftAmount ?? 0) : 0;
          const bDrift = bId ? (priceDrift.get(bId)?.driftAmount ?? 0) : 0;
          return bDrift - aDrift;
        })
    : [];

  // Every "high" confidence match, for the single "Apply all
  // high-confidence matches" button -- deliberately excludes
  // medium/low, mirroring the same split a reviewer would draw by hand
  // (apply what the AI is confident about, review the rest). Distinct
  // from alreadyApplied per group above: this counts how many are still
  // PENDING a real price write, so the button can say "N still need
  // applying" rather than re-offering matches already resolved.
  // Deliberately excludes a drifted target (see priceDrift's own comment
  // above) even though it's technically "not yet applied at this new
  // price" -- a changed vendor number needs the reviewer to actually SEE
  // the old-vs-new comparison and click that row's own Apply, not get
  // silently swept into one "Apply all N" click alongside genuinely new
  // matches. It still shows up in the Match Review table below (see
  // isMatchApplied), just outside this bulk button's reach.
  const highConfidenceMatches = (matches ?? []).filter(
    (m) => m.confidence === "high" && m.lineItemId && !priceDrift.has(m.lineItemId),
  );
  const highConfidencePendingMatches = highConfidenceMatches.filter((m) => {
    const target = allLineItems.find((li) => li.id === m.lineItemId);
    return target?.documentId !== quoteDocument?.id;
  });
  const highConfidencePendingCount = highConfidencePendingMatches.length;
  const highConfidenceTotal = highConfidenceMatches.reduce((sum, m) => sum + m.vendorLine.unitPrice, 0);
  // Shown on the button itself -- previously always the LIFETIME count
  // (confirmed live: a real package showed "Apply all 140" even once 130+
  // had already been applied, with only the Apply/Re-apply verb hinting
  // anything had changed). Once nothing is pending, "Re-apply all" still
  // means the full set (that's what re-affirming everything means), but
  // while some are pending, the number shown is what's actually left to
  // do, not what was ever high-confidence in total.
  const highConfidenceDisplayCount = highConfidencePendingCount > 0 ? highConfidencePendingCount : highConfidenceMatches.length;
  const highConfidenceDisplayTotal =
    highConfidencePendingCount > 0
      ? highConfidencePendingMatches.reduce((sum, m) => sum + m.vendorLine.unitPrice, 0)
      : highConfidenceTotal;

  // A row whose target line item's own documentId already equals this
  // quote's is done -- same "applied" definition every other apply
  // button on this card already uses (alreadyApplied below, bulkGroups'
  // own filter above). Used to keep the Match Review table itself from
  // growing forever: once a row is applied it's removed from view here,
  // same as an applied bulk-suggestion group, so the list actually
  // shrinks as a reviewer works through it instead of accumulating
  // "Re-apply" rows indefinitely. The permanent record lives on the
  // History tab (vendor-match-apply-log-service.ts), not here.
  const isMatchApplied = (m: VendorLineMatch) =>
    allLineItems.find((li) => li.id === m.lineItemId)?.documentId === quoteDocument?.id &&
    !(m.lineItemId && priceDrift.has(m.lineItemId));
  const pendingMatchCount = matches ? matches.filter((m) => !isMatchApplied(m)).length : 0;

  // `doc` (not `quoteDocument`) deliberately -- both render helpers below
  // are declared here, outside the JSX where `quoteDocument` is narrowed
  // non-null by its own `{quoteDocument && ...}` guard, so each takes the
  // already-narrowed document as an explicit parameter from its call site
  // instead of re-deriving it from the (still nullable, from here) outer
  // variable.
  function renderBulkGroupCard(group: { targetId: string; matchIndices: number[] }, doc: NonNullable<typeof quoteDocument>) {
    const targetItem = allLineItems.find((li) => li.id === group.targetId);
    const vendorLines = group.matchIndices
      .map((i) => matches?.[i]?.vendorLine)
      .filter((vl): vl is NonNullable<typeof vl> => !!vl);
    const total = vendorLines.reduce((sum, vl) => sum + vl.unitPrice, 0);
    const groupDrift = priceDrift.get(group.targetId);
    const alreadyApplied = targetItem?.documentId === doc.id && !groupDrift;
    const applyGroupWithIds = applyVendorMatchGroupAction.bind(null, estimateId, versionId, bidPackage.id);
    return (
      <div key={group.targetId} className="rounded-md border border-blue-200 bg-blue-50 p-3">
        <p className="text-sm font-medium">
          <MatchGroupCheckbox indices={group.matchIndices} />{" "}
          {vendorLines.length} vendor lines match &quot;{targetItem?.description ?? "this line item"}&quot;{" "}
          <span className="font-normal text-neutral-500">({money(total)} total)</span>
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          {vendorLines
            .map((vl) => (vl.unitCode ? `${vl.description} [${vl.unitCode}]` : vl.description))
            .join(", ")}
        </p>
        {groupDrift && (
          <p className="mt-1 text-xs font-medium text-amber-700">
            Quote revised since last applied: was {money(groupDrift.previousTotal)} total, vendor lines now sum to{" "}
            {money(groupDrift.newTotal)} — review before updating
          </p>
        )}
        <form action={applyGroupWithIds} className="mt-3 flex items-center gap-2">
          <input type="hidden" name="lineItemId" value={group.targetId} />
          <input type="hidden" name="matchIndices" value={group.matchIndices.join(",")} />
          <input type="hidden" name="documentId" value={doc.id} />
          <input type="hidden" name="priorApplied" value={priorAppliedValue} />
          <Button variant="secondary" type="submit">
            {groupDrift ? "Update" : alreadyApplied ? "Re-apply" : "Apply"} all {vendorLines.length} (sum {money(total)})
          </Button>
          {appliedLineItemIds.has(group.targetId) && (
            <span className="text-xs font-medium text-green-700">✓ Applied</span>
          )}
        </form>
      </div>
    );
  }

  function renderMatchRow(match: VendorLineMatch, i: number, doc: NonNullable<typeof quoteDocument>) {
    // Looked up against allLineItems (every item on the version), not
    // just bidPackage.lineItems -- the AI match pool is version-wide now,
    // so a suggested lineItemId may not be a package member yet (applying
    // it is what adds it, see applyVendorMatchAction's own header comment).
    const matchedItem = allLineItems.find((li) => li.id === match.lineItemId);
    // A stale lineItemId (target row deleted since the match was made --
    // see applyAllHighConfidenceMatchesAction's own self-healing) must
    // never be treated as a real match: it still reads truthy but has no
    // corresponding <option>, so an uncontrolled <select
    // defaultValue={staleId}> would silently render the FIRST option in
    // the whole list instead of erroring, which looks like a real (wrong)
    // selection rather than a missing one.
    const lineItemIdStale = !!match.lineItemId && !matchedItem;
    const resolvedLineItemId = lineItemIdStale ? null : match.lineItemId;
    const suggestedItemExists =
      !!match.suggestedLineItemId && allLineItems.some((li) => li.id === match.suggestedLineItemId);
    const resolvedSuggestedId = suggestedItemExists ? match.suggestedLineItemId : null;
    // "Applied" is derived from provenance (this line item's own
    // documentId equals this quote's), not from a persisted decision.
    // lineItemId only, not suggestedLineItemId -- see priceDrift's own
    // comment above on why: "Quote revised since last applied" only
    // makes sense for a row that was actually applied before, not a
    // still-pending suggestion.
    const drift = match.lineItemId ? priceDrift.get(match.lineItemId) : undefined;
    const alreadyApplied = matchedItem?.documentId === doc.id && !drift;
    // See pendingMatchCount's own comment above -- an applied row is
    // removed from this list entirely, not left with a "Re-apply" button
    // forever, so the table actually shrinks as a reviewer works through
    // it. A drifted row is the one case that looks "applied" by
    // documentId alone but must stay visible.
    if (alreadyApplied) return null;
    // Already actionable from its own bulk-group card above -- see
    // groupedMatchIndices' own comment.
    if (groupedMatchIndices.has(i)) return null;
    const applyWithIds = applyVendorMatchAction.bind(null, estimateId, versionId, bidPackage.id);
    const qtyUnit = vendorLineQtyUnit(match.vendorLine);
    // Jumps to the real page in the source document (same citation.ts
    // pattern used on the Opportunity page). returnTo carries the
    // current ?applied= confirmation list forward -- without this,
    // clicking a citation link and then Back landed on a URL with no
    // applied= param at all, so every "✓ Applied" badge vanished even
    // though the underlying prices were never touched.
    const sourceHref = citationHref(
      opportunityId,
      doc,
      { sourceQuote: match.vendorLine.sourceQuote, pageNumber: match.vendorLine.pageNumber },
      `/estimates/${estimateId}?tab=bid-packages${priorAppliedValue ? `&applied=${encodeURIComponent(priorAppliedValue)}` : ""}#bid-package-${bidPackage.id}`,
    );
    // Deterministic, non-AI last resort so the dropdown is never a cold
    // "— choose one —" against 30-40+ items with no starting point --
    // only reached when the AI itself found NOTHING.
    const fallbackCandidateId =
      !resolvedLineItemId && !resolvedSuggestedId
        ? findClosestCandidateId(match.vendorLine.description, allLineItems)
        : null;
    return (
      <tr key={i} className="border-t border-neutral-100">
        <td className="py-2 pr-1 align-top">
          <MatchRowCheckbox index={i} />
        </td>
        <td className="px-3 py-2 align-top">
          {match.confidence && (
            <span
              className={`mr-1.5 rounded px-1.5 py-0.5 text-xs ${CONFIDENCE_BADGE_CLASS[match.confidence] ?? ""}`}
            >
              {match.confidence}
            </span>
          )}
          {match.needsClarification && (
            <span
              className="mr-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700"
              title="This vendor line's own description doesn't say enough to place it confidently -- worth asking the bidder to clarify."
            >
              needs clarification
            </span>
          )}
          {match.vendorLine.unitCode && (
            <span className="mr-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
              {match.vendorLine.unitCode}
            </span>
          )}
          {sourceHref ? (
            <Link href={sourceHref} className="text-brand-navy hover:underline">
              {match.vendorLine.description}
            </Link>
          ) : (
            match.vendorLine.description
          )}
          {qtyUnit && <span className="ml-1.5 text-xs text-neutral-400">({qtyUnit})</span>}
        </td>
        <td className="px-3 py-2 text-right align-top">{money(match.vendorLine.unitPrice)}</td>
        <td className="px-3 py-2 align-top">
          <select
            name="lineItemId"
            form={`apply-match-${i}`}
            defaultValue={resolvedLineItemId ?? resolvedSuggestedId ?? fallbackCandidateId ?? ""}
            className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          >
            <option value="" disabled={!!(resolvedLineItemId ?? resolvedSuggestedId ?? fallbackCandidateId)}>
              — choose one —
            </option>
            {allLineItems.map((li) => (
              <option key={li.id} value={li.id}>
                {li.description}
                {li.sectionLabel ? ` — ${li.sectionLabel}` : ""}
                {li.bidPackageId && li.bidPackageId !== bidPackage.id ? " (assigned elsewhere)" : ""}
              </option>
            ))}
          </select>
          {lineItemIdStale && (
            <p className="mt-1.5 text-xs text-amber-700">
              This match&apos;s target line item no longer exists (deleted) — pick one manually
            </p>
          )}
          {!lineItemIdStale && drift && (
            <p className="mt-1.5 text-xs font-medium text-amber-700">
              Quote revised since last applied: was {money(drift.previousTotal)} total, vendor lines now sum to{" "}
              {money(drift.newTotal)} — review before updating
            </p>
          )}
          {!lineItemIdStale && !drift && match.reasoning && (
            <p className="mt-1.5 text-xs text-neutral-400">{match.reasoning}</p>
          )}
          {!lineItemIdStale && !resolvedLineItemId && resolvedSuggestedId && (
            <p className="mt-1.5 text-xs text-amber-700">Suggested match pre-filled — review before applying</p>
          )}
          {!lineItemIdStale && !resolvedLineItemId && !resolvedSuggestedId && fallbackCandidateId && (
            <p className="mt-1.5 text-xs text-amber-700">Best guess by description similarity — review before applying</p>
          )}
          {!lineItemIdStale && !resolvedLineItemId && !resolvedSuggestedId && !fallbackCandidateId && (
            <p className="mt-1.5 text-xs text-amber-700">No match — review and pick one manually</p>
          )}
        </td>
        <td className="py-2 pl-3 text-right align-top">
          <form id={`apply-match-${i}`} action={applyWithIds} className="inline">
            <input type="hidden" name="unitCost" value={match.vendorLine.unitPrice} />
            <input type="hidden" name="documentId" value={doc.id} />
            <input type="hidden" name="sourceQuote" value={match.vendorLine.sourceQuote} />
            <input type="hidden" name="priorApplied" value={priorAppliedValue} />
            <input type="hidden" name="index" value={i} />
            <Button variant="secondary" type="submit">
              {drift ? "Update price" : alreadyApplied ? "Re-apply" : "Apply"}
            </Button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <Card id={`bid-package-${bidPackage.id}`} className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-medium">{bidPackage.name}</h3>
          {bidPackage.vendorName && <p className="text-sm text-neutral-500">{bidPackage.vendorName}</p>}
        </div>
        <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs text-neutral-600">
          {BID_PACKAGE_STATUS_LABELS[bidPackage.status] ?? bidPackage.status}
        </span>
      </div>

      <table className="mb-4 w-full text-sm">
        <tbody>
          {bidPackage.lineItems.map((li) => {
            const removeWithIds = removeLineItemFromBidPackageAction.bind(null, estimateId, li.id);
            const sectionLabel = li.section.groupLabel ?? li.section.name;
            const qtyNum = Number(li.qty);
            return (
              <tr key={li.id} className="border-t border-neutral-100">
                <td className="px-3 py-1.5">
                  {li.description}
                  {sectionLabel && <span className="ml-2 text-xs text-neutral-400">{sectionLabel}</span>}
                  {/* Most line items are qty 1, where unit cost and total
                      cost are the same number -- only worth calling out
                      qty/unit cost separately once bulk-apply (see
                      applyVendorMatchGroupAction) has set a real qty > 1
                      with a blended per-unit price, so the total column
                      alone doesn't read as an unexplained lump sum. */}
                  {qtyNum !== 1 && (
                    <span className="ml-2 text-xs text-neutral-400">
                      ({qtyNum}
                      {li.unit ? ` ${li.unit}` : ""} &times; {money(li.unitCost)})
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-neutral-400">{li.category ?? ""}</td>
                <td className="px-3 py-1.5 text-right">{money(li.totalCost)}</td>
                <td className="py-1.5 pl-3 text-right">
                  <form action={removeWithIds} className="inline">
                    <button className="text-xs text-neutral-400 hover:text-red-600" title="Remove from package">
                      ✕
                    </button>
                  </form>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {!quoteDocument && (
        <div className="border-t border-neutral-200 pt-4">
          {vendorQuoteDocuments.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No vendor quote uploaded yet. Upload one from the Opportunity page&apos;s Documents card, tagged
              &quot;Vendor Quote,&quot; then attach it here.
            </p>
          ) : (
            <form action={attachWithIds} className="flex items-end gap-3">
              <div className="flex-1">
                <SelectField
                  label="Attach an uploaded vendor quote"
                  name="documentId"
                  options={vendorQuoteDocuments.map((d) => ({ value: d.id, label: d.filename }))}
                />
              </div>
              <Button variant="secondary">Attach</Button>
            </form>
          )}
        </div>
      )}

      {quoteDocument && isExtracting && (
        <div className="border-t border-neutral-200 pt-4">
          <VendorExtractionProgress
            estimateId={estimateId}
            bidPackageId={bidPackage.id}
            initialPhase={phase}
            initialError={bidPackage.vendorExtractionError}
          />
        </div>
      )}

      {quoteDocument && !isExtracting && phase === "FAILED" && (
        <div className="border-t border-neutral-200 pt-4">
          <p className="mb-3 text-sm text-red-700">
            Extraction failed{bidPackage.vendorExtractionError ? `: ${bidPackage.vendorExtractionError}` : "."}
          </p>
          <SubmitVendorQuoteExtractForm
            estimateId={estimateId}
            bidPackageId={bidPackage.id}
            documentId={quoteDocument.id}
            label="Retry extraction"
          />
        </div>
      )}

      {quoteDocument && !isExtracting && phase !== "FAILED" && !matches && (
        <div className="border-t border-neutral-200 pt-4">
          <p className="mb-3 text-sm text-neutral-500">
            &quot;{quoteDocument.filename}&quot; is attached. {quoteDocument.extractionStatus === "COMPLETE" ? "" : "Click Analyze on it from the Opportunity page first, then "}
            extract its priced line items to match them against this package.
          </p>
          <SubmitVendorQuoteExtractForm
            estimateId={estimateId}
            bidPackageId={bidPackage.id}
            documentId={quoteDocument.id}
          />
        </div>
      )}

      {quoteDocument && !isExtracting && proposedSections.length > 0 && (
        <div className="border-t border-neutral-200 pt-4">
          <h4 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Suggested new sections</h4>
          <div className="flex flex-col gap-3">
            {proposedSections.map((proposal, i) => {
              // Same index-based lookup as commitProposedVendorSectionAction
              // itself -- proposal.vendorLineIndices are positions in the
              // SAME matches array (see ProposedVendorSection's own
              // comment), so this is real vendor line data, not a guess.
              const vendorLines = proposal.vendorLineIndices
                .map((vi) => matches?.[vi]?.vendorLine)
                .filter((vl): vl is NonNullable<typeof vl> => !!vl);
              const total = vendorLines.reduce((sum, vl) => sum + vl.unitPrice, 0);
              const commitWithIds = commitProposedVendorSectionAction.bind(null, estimateId, versionId, bidPackage.id);
              const dismissWithIds = dismissProposedVendorSectionAction.bind(null, estimateId, bidPackage.id);
              return (
                <div key={i} className="rounded-md border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium">
                    &quot;{proposal.name}&quot;{" "}
                    <span className="font-normal text-neutral-500">
                      ({vendorLines.length} vendor line{vendorLines.length === 1 ? "" : "s"}, {money(total)})
                    </span>
                  </p>
                  <p className="mt-1 text-xs text-neutral-600">{proposal.reasoning}</p>
                  <p className="mt-2 text-xs text-neutral-500">{vendorLines.map((vl) => vl.description).join(", ")}</p>
                  <div className="mt-3 flex gap-2">
                    <form action={commitWithIds}>
                      <input type="hidden" name="proposedSectionIndex" value={i} />
                      <Button variant="secondary" type="submit">
                        Create section
                      </Button>
                    </form>
                    <form action={dismissWithIds}>
                      <input type="hidden" name="proposedSectionIndex" value={i} />
                      <Button variant="secondary" type="submit">
                        Dismiss
                      </Button>
                    </form>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {quoteDocument && !isExtracting && (bulkGroups.length > 0 || matches) && (
        <MatchSelectionProvider>
          <ApplySelectedMatchesBar
            applySelected={applySelectedVendorMatchesAction.bind(null, estimateId, versionId, bidPackage.id, quoteDocument.id)}
            estimateId={estimateId}
            bidPackageId={bidPackage.id}
            priorAppliedIds={Array.from(appliedLineItemIds)}
          />

      {bulkGroups.length > 0 && (
        <div className="border-t border-neutral-200 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Bulk match suggestions</h4>
            {/* Reuses MatchGroupCheckbox's own "select all these indices"
                behavior (see its own comment) against the union of every
                group's indices, instead of a reviewer having to click each
                card's checkbox one at a time -- for reviewing N cards and
                approving them all in one shot via the sticky
                ApplySelectedMatchesBar below. */}
            <label className="flex items-center gap-1.5 text-xs text-neutral-500">
              <MatchGroupCheckbox indices={bulkGroups.flatMap((g) => g.matchIndices)} />
              Select all {bulkGroups.length} group{bulkGroups.length === 1 ? "" : "s"}
            </label>
          </div>
          <div className="flex flex-col gap-3">
            {bulkGroups.slice(0, BULK_GROUP_VISIBLE_COUNT).map((group) => renderBulkGroupCard(group, quoteDocument))}
          </div>
          {bulkGroups.length > BULK_GROUP_VISIBLE_COUNT && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm text-neutral-500 hover:text-neutral-700">
                Show {bulkGroups.length - BULK_GROUP_VISIBLE_COUNT} more group
                {bulkGroups.length - BULK_GROUP_VISIBLE_COUNT === 1 ? "" : "s"}
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {bulkGroups.slice(BULK_GROUP_VISIBLE_COUNT).map((group) => renderBulkGroupCard(group, quoteDocument))}
              </div>
            </details>
          )}
        </div>
      )}

      {matches && (
        <div className="border-t border-neutral-200 pt-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Match review — {quoteDocument.filename}
            </h4>
            <div className="flex items-center gap-2">
              {highConfidenceMatches.length > 0 &&
                (highConfidencePendingCount > 0 ? (
                  <form
                    action={applyAllHighConfidenceMatchesAction.bind(null, estimateId, versionId, bidPackage.id)}
                  >
                    <input type="hidden" name="documentId" value={quoteDocument.id} />
                    <input type="hidden" name="priorApplied" value={priorAppliedValue} />
                    <Button variant="secondary" type="submit">
                      Apply all {highConfidenceDisplayCount} high-confidence match
                      {highConfidenceDisplayCount === 1 ? "" : "es"} (sum {money(highConfidenceDisplayTotal)})
                    </Button>
                  </form>
                ) : (
                  // Nothing pending -- this used to say "Re-apply all N
                  // high-confidence matches," which read as an open action
                  // item even though every one of these N is already
                  // correctly applied and unchanged. Confirmed live: a real
                  // user read that as "these need fixing" rather than "these
                  // are fine, here's an optional reconfirm." The button
                  // still exists (re-affirming everything is occasionally
                  // useful, e.g. after editing a target's qty by hand
                  // outside this flow) but no longer looks like a to-do.
                  <div className="flex items-center gap-2 text-sm text-neutral-500">
                    <span className="text-green-700">
                      ✓ All {highConfidenceDisplayCount} high-confidence match
                      {highConfidenceDisplayCount === 1 ? "" : "es"} already applied ({money(highConfidenceDisplayTotal)})
                    </span>
                    <form
                      action={applyAllHighConfidenceMatchesAction.bind(null, estimateId, versionId, bidPackage.id)}
                    >
                      <input type="hidden" name="documentId" value={quoteDocument.id} />
                      <input type="hidden" name="priorApplied" value={priorAppliedValue} />
                      <button type="submit" className="text-xs text-neutral-400 underline hover:text-neutral-600">
                        re-affirm anyway
                      </button>
                    </form>
                  </div>
                ))}
              {/* Once a document has any stored vendorQuoteLineItems,
                  SubmitVendorQuoteExtractForm above never renders again --
                  this is the only way to re-run extraction against updated
                  document text or an updated extraction schema (e.g. after
                  unitCode was added, existing quotes needed this to pick it
                  up rather than staying frozen on their first-ever result). */}
              <SubmitVendorQuoteExtractForm
                estimateId={estimateId}
                bidPackageId={bidPackage.id}
                documentId={quoteDocument.id}
                label="Re-extract"
                pendingLabel="Extracting…"
              />
            </div>
          </div>
          {staleMatchCount > 0 && (
            <p className="mb-3 text-sm text-amber-700">
              {staleMatchCount} match{staleMatchCount === 1 ? "" : "es"} couldn&apos;t be applied -- the line
              item{staleMatchCount === 1 ? " it" : "s they"} pointed to no longer exists (deleted since the match
              was made). Cleared below; try Re-extract or pick a new target manually.
            </p>
          )}
          {pendingMatchCount === 0 ? (
            <p className="mb-4 text-sm text-neutral-500">
              Every match from this quote has been applied — see the History tab for the full record.
            </p>
          ) : (
          <>
          <table className="mb-4 w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="pb-1.5 pr-1"></th>
                <th className="px-3 pb-1.5 font-normal">Vendor line</th>
                <th className="px-3 pb-1.5 text-right font-normal">Vendor price</th>
                <th className="px-3 pb-1.5 font-normal">Matched to</th>
                <th className="pb-1.5 pl-3"></th>
              </tr>
            </thead>
            <tbody>
              {matchIndicesSorted
                .slice(0, MATCH_ROW_VISIBLE_COUNT)
                .map((i) => renderMatchRow(matches[i], i, quoteDocument))}
            </tbody>
          </table>
          {matchIndicesSorted.length > MATCH_ROW_VISIBLE_COUNT && (
            <details className="mb-4">
              <summary className="cursor-pointer text-sm text-neutral-500 hover:text-neutral-700">
                Show {matchIndicesSorted.length - MATCH_ROW_VISIBLE_COUNT} more match
                {matchIndicesSorted.length - MATCH_ROW_VISIBLE_COUNT === 1 ? "" : "es"}
              </summary>
              <table className="mt-2 w-full text-sm">
                <tbody>
                  {matchIndicesSorted
                    .slice(MATCH_ROW_VISIBLE_COUNT)
                    .map((i) => renderMatchRow(matches[i], i, quoteDocument))}
                </tbody>
              </table>
            </details>
          )}
          </>
          )}
          {unmatchedPackageItems.length > 0 && (
            <p className="mb-4 text-sm text-amber-700">
              {unmatchedPackageItems.length} package item{unmatchedPackageItems.length === 1 ? "" : "s"} weren&apos;t
              covered by this quote: {unmatchedPackageItems.map((li) => li.description).join(", ")}.
            </p>
          )}
          <form action={markReviewedWithIds}>
            <Button variant="secondary">Mark reviewed</Button>
          </form>
        </div>
      )}
        </MatchSelectionProvider>
      )}
    </Card>
  );
}

function SubmitVendorQuoteExtractForm({
  estimateId,
  bidPackageId,
  documentId,
  label = "Extract prices",
  pendingLabel = "Extracting…",
}: {
  estimateId: string;
  bidPackageId: string;
  documentId: string;
  label?: string;
  pendingLabel?: string;
}) {
  const extractWithIds = proposeVendorQuoteItemsAction.bind(null, estimateId, bidPackageId, documentId);
  return (
    <form action={extractWithIds}>
      <SubmitButton pendingText={pendingLabel} variant="secondary">
        {label}
      </SubmitButton>
    </form>
  );
}

// Renders one primary category tab's content -- either CategoryTabContent
// unchanged (a flat category, or a Type with no live Method split), or,
// for a Type that does have one, an "All" pill plus one pill per Method
// (Rental/Purchase/Custom Fabricated) above it, each still delegating to
// CategoryTabContent for a single bucket. All composition (merging the
// Type's own bucket with its Method buckets for "All") happens here so
// CategoryTabContent itself stays unaware of the grouping above it.
function PrimaryCategoryTabContent({
  tab,
  boothGroupsByCategoryName,
  ...rest
}: {
  tab: PrimaryCategoryTab<SectionLineItem>;
  boothGroupsByCategoryName: Map<string, RawBoothGroup<SectionLineItem>[]>;
  version: VersionWithSections;
  estimateId: string;
  opportunityId: string;
  laborRates: LaborRateOption[];
  categoryOptions: { value: string; label: string }[];
  attachments: { id: string; fileRef: string }[];
  users: { id: string; name: string }[];
  categories: { id: string; name: string; key: string; parentId: string | null }[];
  marginOverrideByCategoryId: Map<string, Prisma.Decimal>;
}) {
  if (!tab.hasMethodSplit) {
    return (
      <CategoryTabContent
        bucket={tab.ownBucket}
        boothGroups={boothGroupsByCategoryName.get(tab.ownBucket.category.name)}
        {...rest}
      />
    );
  }

  const allBucket = mergeCategoryBucketsForAllMethods(tab);
  const allBoothGroups = mergeBoothGroupsForAllMethods(tab, boothGroupsByCategoryName);

  return (
    <CategoryMethodFilter
      options={[
        { id: "all", label: "All", count: tab.totalItems },
        ...tab.methodBuckets.map((m) => ({ id: m.key, label: m.label, count: m.bucket.totalItems })),
      ]}
      content={{
        all: <CategoryTabContent bucket={allBucket} boothGroups={allBoothGroups} {...rest} />,
        ...Object.fromEntries(
          tab.methodBuckets.map((m) => [
            m.key,
            <CategoryTabContent
              key={m.key}
              bucket={m.bucket}
              boothGroups={boothGroupsByCategoryName.get(m.bucket.category.name)}
              {...rest}
            />,
          ]),
        ),
      }}
    />
  );
}

function CategoryTabContent({
  bucket,
  version,
  estimateId,
  opportunityId,
  laborRates,
  categoryOptions,
  attachments,
  users,
  boothGroups,
  categories,
  marginOverrideByCategoryId,
}: {
  bucket: RawCategoryBucket<SectionLineItem>;
  version: VersionWithSections;
  estimateId: string;
  opportunityId: string;
  laborRates: LaborRateOption[];
  categoryOptions: { value: string; label: string }[];
  attachments: { id: string; fileRef: string }[];
  users: { id: string; name: string }[];
  // Only passed for the Rental Structures/Custom Components categories,
  // when this version has any booth-linked sections tagged into this one
  // (see LineItemsTab's own comment). Every one of these items already
  // renders here via this grouped view, so the flat sectionGroups list
  // below excludes them (see flatSectionGroups) -- never both.
  boothGroups?: RawBoothGroup<SectionLineItem>[];
  categories: { id: string; name: string; key: string; parentId: string | null }[];
  marginOverrideByCategoryId: Map<string, Prisma.Decimal>;
}) {
  const hasBoothGroups = !!boothGroups && boothGroups.length > 0;
  const flatSectionGroups = hasBoothGroups ? bucket.sectionGroups.filter((g) => !g.groupLabel) : bucket.sectionGroups;
  // No "— auto-detect —" entry here (unlike AddLineItemForm's own
  // categoryOptions) -- moving a whole section only makes sense to a real,
  // explicit category, never back to a guess.
  const moveCategoryOptions = categoryOptions.filter((o) => o.value !== "");

  // Grosses up at THIS bucket's own resolved category's margin (its
  // override if set, else the document target) -- not one global
  // grandTotal/totalCost ratio anymore, now that different categories can
  // carry different margins. Approximate for the "All" merged Method view
  // (mergeCategoryBucketsForAllMethods) specifically: that bucket's
  // sectionGroups can span several leaf categories (Rental/Purchase/
  // Custom Fabricated) that could each carry their own override, but this
  // preview still prices the whole merged subtotal at the Type's own
  // margin -- correct for every non-merged bucket (every flat category
  // and every single-Method-filtered view, which is the common case), an
  // approximation only for "All." Internal estimator preview only; the
  // client-facing Proposal PDF (proposal-pdf.tsx) grosses up per line item
  // for full correctness.
  const bucketMarginPct = resolveLineItemMarginPct(bucket.category.name, categories, marginOverrideByCategoryId, version.marginTargetPct);
  const sell = (cost: number) => computeMarginGrossUp(cost, bucketMarginPct).toNumber();

  if (flatSectionGroups.length === 0 && !hasBoothGroups) {
    const firstSection = version.sections[0];
    return (
      <div className="pt-2">
        <p className="mb-4 text-sm text-neutral-500">No {bucket.category.name} line items yet.</p>
        {!version.isLocked &&
          (!firstSection ? (
            <p className="text-sm text-neutral-400">Add a section below before adding line items.</p>
          ) : version.sections.length > 1 ? (
            // More than one section exists -- don't silently attach the
            // first item in an empty category to whichever section
            // happens to be first. Let the user pick.
            <SectionScopedForm
              sections={version.sections.map((s) => ({ id: s.id, name: s.name }))}
              content={Object.fromEntries(
                version.sections.map((s) => [
                  s.id,
                  <AddLineItemForm
                    key={s.id}
                    estimateId={estimateId}
                    versionId={version.id}
                    sectionId={s.id}
                    attachments={attachments}
                    laborRates={laborRates}
                    categoryOptions={categoryOptions}
                    defaultCategory={bucket.category.name}
                  />,
                ]),
              )}
            />
          ) : (
            <AddLineItemForm
              estimateId={estimateId}
              versionId={version.id}
              sectionId={firstSection.id}
              attachments={attachments}
              laborRates={laborRates}
              categoryOptions={categoryOptions}
              defaultCategory={bucket.category.name}
            />
          ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 pt-2">
      {hasBoothGroups && (
        <div className="flex flex-col gap-8">
          {boothGroups!.map((booth) => (
            <div key={booth.boothLabel} className="overflow-hidden rounded-md border border-neutral-200">
              <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-900 px-4 py-2.5 text-white">
                <h4 className="text-sm font-semibold uppercase tracking-wide">
                  <SectionHeadingEditor
                    fallbackLabel={booth.boothLabel}
                    description={booth.boothDescription}
                    pendingDescription={booth.boothPendingDescription}
                    isMapped={false}
                    isLocked={version.isLocked}
                    theme="dark"
                    suggestAction={suggestBoothDescriptionAction.bind(null, estimateId, version.id, booth.boothLabel)}
                    updateAction={updateBoothDescriptionAction.bind(null, estimateId, version.id, booth.boothLabel)}
                    rejectAction={clearBoothPendingDescriptionAction.bind(null, estimateId, version.id, booth.boothLabel)}
                  />
                </h4>
                <div className="flex items-center gap-3">
                  <div className="text-xs">
                    <span className="text-neutral-400">Cost {money(booth.subtotal)}</span>
                    <span className="mx-1.5 text-neutral-500">&rarr;</span>
                    <span className="font-semibold">{money(sell(booth.subtotal))}</span>
                  </div>
                  {!version.isLocked && (
                    <form action={untagSectionBuildTypeAction.bind(null, estimateId, version.id, booth.boothLabel)}>
                      <button
                        type="submit"
                        className="rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                        title="Move this component's items back to their own raw categories"
                      >
                        Untag
                      </button>
                    </form>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-5 p-4">
                {booth.elementGroups.map((group) => (
                  <div key={group.elementType}>
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded bg-neutral-100 px-3 py-1.5">
                      <h5 className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
                        <SectionHeadingEditor
                          fallbackLabel={group.elementType}
                          description={group.description}
                          pendingDescription={group.pendingDescription}
                          isMapped={group.isMapped}
                          isLocked={version.isLocked}
                          suggestAction={suggestSectionDescriptionAction.bind(null, estimateId, group.sectionIds[0])}
                          updateAction={updateSectionDescriptionAction.bind(null, estimateId, group.sectionIds[0])}
                          rejectAction={clearSectionPendingDescriptionAction.bind(null, estimateId, group.sectionIds[0])}
                        />
                      </h5>
                      <div className="text-xs text-neutral-600">
                        <span className="text-neutral-400">Cost {money(group.subtotal)}</span>
                        <span className="mx-1.5">&rarr;</span>
                        <span className="font-medium">{money(sell(group.subtotal))}</span>
                      </div>
                    </div>
                    <div className="overflow-x-auto rounded-md border border-neutral-200">
                      <LineItemsTable
                        lineItems={group.items}
                        version={version}
                        estimateId={estimateId}
                        opportunityId={opportunityId}
                        laborRates={laborRates}
                        categoryOptions={categoryOptions}
                      />
                    </div>
                    {!version.isLocked && (
                      <div className="mt-2">
                        {/* sectionIds is almost always length 1 (see RawElementTypeGroup's
                            own comment); a new item always attaches to the first, same
                            representative section the description editor above already uses. */}
                        <AddLineItemForm
                          estimateId={estimateId}
                          versionId={version.id}
                          sectionId={group.sectionIds[0]}
                          laborRates={laborRates}
                          categoryOptions={categoryOptions}
                          defaultCategory={bucket.category.name}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {flatSectionGroups.map((group) => (
        <div key={group.sectionId} className="border-t border-neutral-200 pt-4 first:border-t-0 first:pt-0">
          <h4 className="mb-3 flex flex-wrap items-center gap-2 text-sm font-medium text-neutral-700">
            <SectionHeadingEditor
              fallbackLabel={group.sectionName}
              description={group.description}
              pendingDescription={group.pendingDescription}
              isMapped={group.isMapped}
              isLocked={version.isLocked}
              suggestAction={suggestSectionDescriptionAction.bind(null, estimateId, group.sectionId)}
              updateAction={updateSectionDescriptionAction.bind(null, estimateId, group.sectionId)}
              rejectAction={clearSectionPendingDescriptionAction.bind(null, estimateId, group.sectionId)}
            />
            {group.groupLabel && <span className="font-normal text-neutral-500">— {group.groupLabel}</span>}
            {!version.isLocked && (
              <form
                action={updateSectionItemsCategoryAction.bind(null, estimateId, version.id, group.sectionId)}
                className="ml-auto flex items-center gap-1.5"
              >
                <SelectField label="" name="category" defaultValue={group.categoryName} options={moveCategoryOptions} />
                <Button variant="secondary" type="submit">
                  Move section
                </Button>
              </form>
            )}
          </h4>
          <SectionLineItemsBlock
            lineItems={group.lineItems}
            version={version}
            estimateId={estimateId}
            opportunityId={opportunityId}
            laborRates={laborRates}
            categoryOptions={categoryOptions}
          />
          {version.isLocked && (
            <>
              <p className="mb-3 text-xs text-neutral-400 sm:hidden">← Scroll the table for Actual &amp; Variance</p>
              <div className="mb-3 flex flex-col gap-2">
                {group.lineItems.map((li) => (
                  <RecordActualForm key={li.id} estimateId={estimateId} lineItem={li} users={users} />
                ))}
              </div>
            </>
          )}
          {!version.isLocked && (
            <AddLineItemForm
              estimateId={estimateId}
              versionId={version.id}
              sectionId={group.sectionId}
              attachments={attachments}
              laborRates={laborRates}
              categoryOptions={categoryOptions}
              defaultCategory={bucket.category.name}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function OptionCard({
  estimateId,
  opportunityId,
  version,
  option,
  isLocked,
  laborRates,
  categoryOptions,
}: {
  estimateId: string;
  opportunityId: string;
  version: VersionWithSections;
  option: VersionWithSections["options"][number];
  isLocked: boolean;
  laborRates: { id: string; label: string; department: string | null; rate: number }[];
  categoryOptions: { value: string; label: string }[];
}) {
  const addOptionSectionWithIds = addOptionSectionAction.bind(null, estimateId, version.id, option.id);
  const optionTotal = computeOptionTotal(option.sections);

  return (
    <div className="rounded-md border border-dashed border-neutral-300 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h4 className="font-medium">{option.name}</h4>
        <span className="text-sm font-medium text-neutral-700">{money(optionTotal)}</span>
      </div>
      {option.sections.map((section) => (
        <div key={section.id} className="mb-3">
          <h5 className="mb-2 text-sm text-neutral-500">{section.name}</h5>
          {section.lineItems.length > 0 && (
            <div className="mb-2 overflow-x-auto rounded-md border border-neutral-200">
              <LineItemsTable
                lineItems={section.lineItems}
                version={version}
                estimateId={estimateId}
                opportunityId={opportunityId}
                laborRates={laborRates}
                categoryOptions={categoryOptions}
              />
            </div>
          )}
          {!isLocked && (
            <AddLineItemForm
              estimateId={estimateId}
              versionId={version.id}
              sectionId={section.id}
              laborRates={laborRates}
              categoryOptions={categoryOptions}
            />
          )}
        </div>
      ))}
      {!isLocked && (
        <form action={addOptionSectionWithIds} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="New section name" name="name" placeholder="e.g. COMPONENT 1" required />
          </div>
          <div className="w-40">
            <SelectField label="Type" name="sectionType" defaultValue="COMPONENT" options={SECTION_TYPE_OPTIONS} />
          </div>
          <Button variant="secondary">Add section</Button>
        </form>
      )}
    </div>
  );
}

// migration-plan.md Phase 6 scope: "variance reporting ... by
// department/category/job." Department comes from LineItem.department;
// "job" is this estimate itself, so the whole card already scopes to it.
function VarianceByDepartment({
  sections,
}: {
  sections: {
    lineItems: {
      id: string;
      description: string;
      department: string | null;
      totalCost: Prisma.Decimal;
      costActuals: { actualCost: Prisma.Decimal }[];
    }[];
  }[];
}) {
  const rows = computeLineItemVariance(sections.flatMap((s) => s.lineItems));
  const hasActuals = rows.some((r) => r.actualCost.toNumber() !== 0);
  if (!hasActuals) return null;

  const byDept = computeDepartmentVariance(rows);

  return (
    <div className="mb-6 rounded-md border border-neutral-200 p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
        Variance by department
      </h3>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-neutral-500">
            <th className="pb-1 font-normal">Department</th>
            <th className="pb-1 text-right font-normal">Estimated</th>
            <th className="pb-1 text-right font-normal">Actual</th>
            <th className="pb-1 text-right font-normal">Variance</th>
          </tr>
        </thead>
        <tbody>
          {byDept.map((d) => (
            <tr key={d.department} className="border-t border-neutral-100">
              <td className="py-1.5">{d.department}</td>
              <td className="py-1.5 text-right">{money(d.estimatedCost)}</td>
              <td className="py-1.5 text-right">{money(d.actualCost)}</td>
              <td
                className={`py-1.5 text-right ${d.variance.isPositive() ? "text-red-600" : d.variance.isNegative() ? "text-green-600" : ""}`}
              >
                {d.variance.isPositive() ? "+" : ""}
                {money(d.variance)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecordActualForm({
  estimateId,
  lineItem,
  users,
}: {
  estimateId: string;
  lineItem: { id: string; description: string };
  users: { id: string; name: string }[];
}) {
  const recordActualWithIds = recordCostActualAction.bind(null, estimateId, lineItem.id);
  return (
    <form action={recordActualWithIds} className="flex flex-wrap items-end gap-3 rounded-md bg-neutral-50 p-3 text-sm">
      <span className="pb-2 text-neutral-500">{lineItem.description}:</span>
      <div className="w-28">
        <Field label="Actual cost ($)" name="actualCost" type="number" required />
      </div>
      <div className="w-40">
        <Field label="Source" name="source" placeholder="e.g. Vendor invoice #123" />
      </div>
      <div className="w-40">
        <SelectField
          label="Recorded by"
          name="recordedById"
          options={[{ value: "", label: "— unspecified —" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
        />
      </div>
      <Button variant="secondary">Record actual</Button>
    </form>
  );
}

function AddLineItemForm({
  estimateId,
  versionId,
  sectionId,
  attachments = [],
  laborRates = [],
  categoryOptions,
  defaultCategory = "",
}: {
  estimateId: string;
  versionId: string;
  sectionId: string;
  attachments?: { id: string; fileRef: string }[];
  laborRates?: { id: string; label: string; department: string | null; rate: number }[];
  categoryOptions: { value: string; label: string }[];
  // Prefills the category (and, via LaborRateLineItemFields, whether the
  // labor-rate picker shows) when adding from a specific category tab --
  // e.g. inside the "Labor" tab, a new line item should default to
  // Labor, not fall through to auto-detect the way the old flat
  // per-section form always did.
  defaultCategory?: string;
}) {
  const addLineItemWithIds = addLineItemAction.bind(null, estimateId, versionId, sectionId);
  // Zero-JS disclosure (native <details>/<summary>, same pattern as
  // CollapsibleSection) -- collapsed by default to an icon-only trigger so
  // every group gets one small "add" affordance instead of a permanently
  // open form box taking up space in each section/booth/option.
  return (
    <details className="group/add-line-item">
      <summary
        className="flex h-7 w-7 cursor-pointer list-none items-center justify-center rounded-full border border-dashed border-neutral-300 text-neutral-500 transition-colors hover:border-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 marker:content-none [&::-webkit-details-marker]:hidden"
        title="Add line item"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <span className="sr-only">Add line item</span>
      </summary>
      <form
        action={addLineItemWithIds}
        className="mt-2.5 grid grid-cols-2 gap-3 rounded-md border border-dashed border-neutral-300 bg-neutral-50 p-3 sm:flex sm:flex-wrap sm:items-end"
      >
        <div className="col-span-2 sm:order-2 sm:flex-1 sm:min-w-[10rem]">
          <Field label="Description" name="description" required />
        </div>
        <div className="sm:order-1 sm:w-36">
          <SelectField label="Type" name="lineType" defaultValue="MATERIAL" options={LINE_TYPE_OPTIONS} />
        </div>
        <LaborRateLineItemFields categoryOptions={categoryOptions} laborRates={laborRates} defaultCategory={defaultCategory} />
        <QuantityOrAreaFields defaultQty="1" />
        <div className="sm:order-9 sm:w-36">
          <SelectField label="Usage" name="usageTag" defaultValue="" options={LINE_ITEM_USAGE_TAG_OPTIONS} />
        </div>
        <label className="col-span-2 flex items-center gap-1.5 pb-2 text-sm text-neutral-700 sm:order-10 sm:col-span-1">
          <input type="checkbox" name="isClientOwned" />
          Client owned (no charge)
        </label>
        {attachments.length > 0 && (
          <>
            <div className="col-span-2 sm:order-11 sm:w-40 sm:col-span-1">
              <SelectField
                label="From attachment"
                name="attachmentId"
                options={[{ value: "", label: "— none —" }, ...attachments.map((a) => ({ value: a.id, label: a.fileRef }))]}
              />
            </div>
            <label className="col-span-2 flex items-center gap-1.5 pb-2 text-sm text-neutral-700 sm:order-12 sm:col-span-1">
              <input type="checkbox" name="isDraft" /> Draft
            </label>
          </>
        )}
        <div className="col-span-2 sm:order-[13]">
          <Button variant="secondary">Add line item</Button>
        </div>
      </form>
    </details>
  );
}

// "Documents" tab: everything that reads source documents to populate or
// support line items -- Attachments (referenced design files), Build
// from all documents, Import from a Pricing Schedule, Propose from a
// Scope of Work/drawing. Grouped together because they're all inputs
// into the estimate, distinct from Review's audits of what's already
// there.
function DocumentsTab({
  estimateId,
  opportunityId,
  users,
  attachments,
  addAttachmentAction,
  canImport,
  buildEstimateAction,
  buildResult,
  pricingScheduleDocuments,
  previewImportAction,
  importDocumentId,
  importPreview,
  mirrorDocuments,
  currentVersion,
  scopeDocuments,
  proposeScopeItemsAction,
  proposeDocumentId,
  proposeDocument,
  proposedItems,
  proposeCatalog,
  estimateNameById,
  cadDocuments,
  reconcilePullSheetAction,
  reconcileResult,
  previewPullSheetEnrichmentAction,
  applyPullSheetEnrichmentAction,
  enrichCadDocumentId,
  enrichResult,
  enrichApplied,
}: {
  estimateId: string;
  opportunityId: string;
  users: { id: string; name: string }[];
  attachments: { id: string; fileRef: string; uploadedBy: { name: string } | null }[];
  addAttachmentAction: (formData: FormData) => void | Promise<void>;
  canImport: boolean;
  buildEstimateAction: ((formData: FormData) => void | Promise<void>) | null;
  buildResult: BuildEstimateResult | null;
  pricingScheduleDocuments: { id: string; filename: string; alreadyImported: boolean }[];
  previewImportAction: (formData: FormData) => void | Promise<void>;
  importDocumentId: string | undefined;
  importPreview: Awaited<ReturnType<typeof previewPricingImport>> | Error | null;
  mirrorDocuments: { id: string; filename: string; buildName: string | null }[];
  currentVersion: VersionWithSections;
  scopeDocuments: { id: string; filename: string }[];
  proposeScopeItemsAction: (formData: FormData) => void | Promise<void>;
  proposeDocumentId: string | undefined;
  proposeDocument: { id: string; filename: string } | null;
  proposedItems: ProposedLineItem[] | null;
  proposeCatalog: Awaited<ReturnType<typeof loadCatalogForMatching>>;
  estimateNameById: Map<string, string>;
  cadDocuments: { id: string; filename: string }[];
  reconcilePullSheetAction: (formData: FormData) => void | Promise<void>;
  reconcileResult: ReconciliationResult | null;
  previewPullSheetEnrichmentAction: ((formData: FormData) => void | Promise<void>) | null;
  applyPullSheetEnrichmentAction: ((formData: FormData) => void | Promise<void>) | null;
  enrichCadDocumentId: string | undefined;
  enrichResult: EnrichmentPreviewResult | null;
  enrichApplied: number | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Attachments</h2>
        <p className="mb-4 text-sm text-neutral-500">
          Design files (pull sheets, artwork) referenced by filename or an external link -- ForgeOS doesn&apos;t
          host files yet, matching how artwork already moves via FTP/WeTransfer outside the workbook.
        </p>
        {attachments.length > 0 && (
          <ul className="mb-4 flex flex-col gap-1 text-sm">
            {attachments.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                <span>{a.fileRef}</span>
                <span className="text-neutral-500">{a.uploadedBy?.name ?? "unknown"}</span>
              </li>
            ))}
          </ul>
        )}
        <form action={addAttachmentAction} className="flex items-end gap-3">
          <div className="flex-1">
            <Field label="File reference" name="fileRef" placeholder="e.g. pull-sheet-v1.pdf or a WeTransfer link" required />
          </div>
          <div className="w-48">
            <SelectField
              label="Uploaded by"
              name="uploadedById"
              options={[{ value: "", label: "— unspecified —" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
            />
          </div>
          <Button variant="secondary">Add attachment</Button>
        </form>
      </Card>

      {canImport && buildEstimateAction && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Build estimate from all documents
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Runs the Pricing Schedule import and Scope of Work proposal below across every analyzed document for
            this Opportunity in one pass, instead of picking one at a time -- skips anything already imported, not
            yet analyzed, or that turns up nothing to propose.
          </p>
          {buildResult && (
            <div className="mb-4 flex flex-col gap-2 text-sm">
              {buildResult.imported.length > 0 && (
                <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2">
                  <p className="mb-1 font-medium text-green-900">Imported {buildResult.imported.length} document(s):</p>
                  <ul className="flex flex-col gap-0.5 text-green-800">
                    {buildResult.imported.map((r, i) => (
                      <li key={i}>
                        {r.filename} — {r.rowsImported} {r.kind === "pricing" ? "pricing rows" : "proposed items"}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {buildResult.skipped.length > 0 && (
                <div className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2">
                  <p className="mb-1 font-medium text-neutral-700">Skipped {buildResult.skipped.length} document(s):</p>
                  <ul className="flex flex-col gap-0.5 text-neutral-600">
                    {buildResult.skipped.map((r, i) => (
                      <li key={i}>
                        {r.filename} — {r.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {buildResult.imported.length === 0 && buildResult.skipped.length === 0 && (
                <p className="text-neutral-500">No documents found for this Opportunity yet.</p>
              )}
            </div>
          )}
          <form action={buildEstimateAction}>
            <SubmitButton pendingText="Building…" variant="primary">
              Build from all analyzed documents
            </SubmitButton>
          </form>
        </Card>
      )}

      {canImport && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Import from document
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Parses a Pricing Schedule spreadsheet (uploaded on the Opportunity&apos;s Documents card) straight
            into draft line items with qty/unit already filled in. A row seeds its Unit Rate from a confident
            catalog match when one exists (shown below) — otherwise it starts at $0, pending review either way.
          </p>
          {pricingScheduleDocuments.length === 0 ? (
            <Notice
              message="No pricing-schedule documents uploaded yet."
              actionHref={`/opportunities/${opportunityId}`}
              actionLabel="Go to Opportunity"
            />
          ) : (
            <form action={previewImportAction} className="flex items-end gap-3">
              <div className="flex-1">
                <SelectField
                  label="Document"
                  name="documentId"
                  defaultValue={importDocumentId ?? ""}
                  options={pricingScheduleDocuments.map((d) => ({
                    value: d.id,
                    label: d.alreadyImported ? `${d.filename} (already imported)` : d.filename,
                  }))}
                />
              </div>
              <Button variant="secondary">Preview import</Button>
            </form>
          )}

          {importPreview instanceof Error && (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {importPreview.message}
            </p>
          )}

          {importPreview && !(importPreview instanceof Error) && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-sm text-neutral-700">
                <span className="font-medium">{importPreview.rows.length}</span> line items
                {"categories" in importPreview && (
                  <>
                    {" "}
                    across <span className="font-medium">{importPreview.categories.length}</span> categories
                  </>
                )}{" "}
                in <span className="font-medium">{importPreview.filename}</span>
                {"sheetName" in importPreview && ` (${importPreview.sheetName})`}.
              </p>

              {importPreview.kind === "vendor-quote" && (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  These line items are AI-extracted directly from this vendor quote&apos;s own pricing table — verify
                  every row against the source before committing.
                </p>
              )}

              {importPreview.kind === "ai-proposed" && (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  This spreadsheet&apos;s layout wasn&apos;t recognized by either deterministic importer, so these
                  rows are AI-proposed from its raw content instead of read directly from fixed columns — verify
                  every row against the source before committing. A qty marked{" "}
                  <span className="text-amber-600">*</span> wasn&apos;t explicitly stated in the sheet; committing
                  appends &quot;(qty estimated — verify)&quot; to that row&apos;s description as a permanent flag.
                </p>
              )}

              {/* Flag-only -- see mirrorDocuments' own comment above on why
                  this never auto-copies pricing. A reviewer decides whether
                  a shared Build Name means "intentionally mirrored, import
                  as-is" or "accidentally duplicated, go verify the real
                  drawing before trusting this." */}
              {importPreview.kind === "design-cost-estimate" && mirrorDocuments.length > 0 && (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  This booth&apos;s Build Name (<span className="font-medium">{importPreview.buildName}</span>) matches{" "}
                  {mirrorDocuments.length} other uploaded document{mirrorDocuments.length === 1 ? "" : "s"}:{" "}
                  {mirrorDocuments.map((d) => d.filename).join(", ")} — verify quantities before importing, this may
                  be an intentionally mirrored design or an accidental duplicate.
                </p>
              )}

              <div className="mb-4 max-h-64 overflow-y-auto rounded-md border border-neutral-200">
                {importPreview.kind === "design-cost-estimate" ? (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr className="text-left text-neutral-500">
                        <th className="px-2 py-1.5 font-normal">Category</th>
                        <th className="px-2 py-1.5 font-normal">Description</th>
                        <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row) => (
                        <tr key={row.rowNumber} className="border-t border-neutral-100">
                          <td className="px-2 py-1 text-neutral-500">{row.category}</td>
                          <td className="max-w-[24rem] truncate px-2 py-1" title={row.description}>
                            {row.description.split("\n")[0]}
                          </td>
                          <td className="px-2 py-1 text-right">{row.qty}</td>
                          <td className="px-2 py-1 text-right">
                            {row.unitCost > 0 ? (
                              `$${row.unitCost.toFixed(2)}`
                            ) : (
                              <span className="text-neutral-400" title="Not yet priced in the source workbook">
                                $0.00
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : importPreview.kind === "ai-proposed" ? (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr className="text-left text-neutral-500">
                        <th className="px-2 py-1.5 font-normal">Category</th>
                        <th className="px-2 py-1.5 font-normal">Description</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit</th>
                        <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row, i) => (
                        <tr key={i} className="border-t border-neutral-100">
                          <td className="px-2 py-1 text-neutral-500">{row.category}</td>
                          <td className="max-w-[24rem] truncate px-2 py-1" title={row.sourceQuote}>
                            {row.description}
                          </td>
                          <td className="px-2 py-1 text-right">{row.unit}</td>
                          <td className="px-2 py-1 text-right">
                            {row.qty}
                            {!row.qtyIsExplicit && (
                              <span className="ml-1 text-amber-600" title="Not stated in the source -- a placeholder, not a real quantity.">
                                *
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {row.unitCost > 0 ? (
                              `$${row.unitCost.toFixed(2)}`
                            ) : (
                              <span className="text-neutral-400" title="Not yet priced in the source spreadsheet">
                                $0.00
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : importPreview.kind === "module-cost-estimate" ? (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr className="text-left text-neutral-500">
                        <th className="px-2 py-1.5 font-normal">Category</th>
                        <th className="px-2 py-1.5 font-normal">Description</th>
                        <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row, i) => (
                        <tr key={i} className="border-t border-neutral-100">
                          <td className="px-2 py-1 text-neutral-500">{row.category ?? "—"}</td>
                          <td className="max-w-[24rem] truncate px-2 py-1" title={row.sourceQuote}>
                            {row.description}
                          </td>
                          <td className="px-2 py-1 text-right">{row.qty}</td>
                          <td className="px-2 py-1 text-right">${row.unitCost.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : importPreview.kind === "vendor-quote" ? (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr className="text-left text-neutral-500">
                        <th className="px-2 py-1.5 font-normal">Description</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit</th>
                        <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit price</th>
                        <th className="px-2 py-1.5 text-right font-normal">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row, i) => (
                        <tr key={i} className="border-t border-neutral-100">
                          <td className="max-w-[24rem] truncate px-2 py-1" title={row.sourceQuote}>
                            {row.description}
                          </td>
                          <td className="px-2 py-1 text-right">{row.unit ?? ""}</td>
                          <td className="px-2 py-1 text-right">{row.qty ?? "—"}</td>
                          <td className="px-2 py-1 text-right">${row.unitPrice.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right">
                            ${(row.totalPrice ?? row.unitPrice * (row.qty ?? 1)).toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-neutral-50">
                      <tr className="text-left text-neutral-500">
                        <th className="px-2 py-1.5 font-normal">Category</th>
                        <th className="px-2 py-1.5 font-normal">Description</th>
                        <th className="px-2 py-1.5 text-right font-normal">Unit</th>
                        <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                        <th className="px-2 py-1.5 text-right font-normal">Suggested rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.rows.map((row) => (
                        <tr key={row.rowNumber} className="border-t border-neutral-100">
                          <td className="px-2 py-1 text-neutral-500">{row.category}</td>
                          <td className="max-w-[24rem] truncate px-2 py-1" title={row.description}>
                            {row.description.split("\n")[0]}
                          </td>
                          <td className="px-2 py-1 text-right">{row.unit}</td>
                          <td className="px-2 py-1 text-right">{row.qty}</td>
                          <td className="px-2 py-1 text-right">
                            {row.catalogMatch ? (
                              <span
                                className="text-brand-navy"
                                title={`Matched to ${row.catalogMatch.source} catalog: "${row.catalogMatch.name}" -- verify before relying on it.`}
                              >
                                ${row.catalogMatch.unitCost.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-neutral-400">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <form action={commitImportAction.bind(null, estimateId, currentVersion.id, importPreview.documentId)}>
                {importPreview.kind === "ai-proposed" &&
                  findAlternateGroups(importPreview.rows).map((group) => (
                    <div
                      key={group.alternateGroupLabel}
                      className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
                    >
                      <p className="mb-2">
                        <span className="font-medium">{group.alternateGroupLabel}</span> — these{" "}
                        {group.sheetNames.length} sheets look like mutually exclusive alternatives for the same
                        scope, not separate real costs. Choose where each one goes before committing, or the total
                        will double-count whichever one you don&apos;t actually pick.
                      </p>
                      <div className="flex flex-col gap-2">
                        {group.sheetNames.map((sheetName, i) => (
                          <div key={sheetName} className="flex flex-wrap items-center gap-2">
                            <span className="w-40 shrink-0 font-medium text-amber-900">{sheetName}</span>
                            <span className="w-24 shrink-0 text-right text-amber-900">
                              ${group.totalBySheet[sheetName].toFixed(2)}
                            </span>
                            <select
                              name={`destination__${sheetName}`}
                              defaultValue={i === 0 ? "base" : "option"}
                              className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900"
                            >
                              <option value="base">Commit to base version</option>
                              <option value="option">Commit as a new option</option>
                            </select>
                            <input
                              type="text"
                              name={`optionName__${sheetName}`}
                              defaultValue={`${group.alternateGroupLabel} — ${sheetName}`}
                              placeholder="Option name"
                              className="min-w-[12rem] flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                <Button>
                  Commit {importPreview.rows.length} draft line items
                </Button>
              </form>
            </div>
          )}
        </Card>
      )}

      {canImport && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Propose line items from a document
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            For an RFP with no pre-built pricing schedule -- reads an analyzed Scope of Work (or the page images of
            a drawing/rendering) and proposes draft line items. Unlike a real pricing schedule, quantities here are
            often AI-inferred, not read from the source: rows marked{" "}
            <span className="italic">(qty estimated — verify)</span> had no explicit quantity in the document at
            all. Verify every row against the source before relying on it.
          </p>
          {scopeDocuments.length === 0 ? (
            <Notice
              message="No analyzed documents yet -- click Analyze on a document from the Opportunity page first."
              actionHref={`/opportunities/${opportunityId}`}
              actionLabel="Go to Opportunity"
            />
          ) : (
            <form action={proposeScopeItemsAction} className="flex items-end gap-3">
              <div className="flex-1">
                <SelectField
                  label="Document"
                  name="documentId"
                  defaultValue={proposeDocumentId ?? ""}
                  options={scopeDocuments.map((d) => ({ value: d.id, label: d.filename }))}
                />
              </div>
              <SubmitButton pendingText="Proposing…" variant="secondary">
                Propose items
              </SubmitButton>
            </form>
          )}

          {proposeDocument && proposedItems && proposedItems.length === 0 && (
            <p className="mt-4 text-sm text-neutral-500">
              No concrete scope items found in &quot;{proposeDocument.filename}&quot;.
            </p>
          )}

          {proposeDocument && proposedItems && proposedItems.length > 0 && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-sm text-neutral-700">
                <span className="font-medium">{proposedItems.length}</span> proposed line items in{" "}
                <span className="font-medium">{proposeDocument.filename}</span> — AI-drafted, verify before
                committing.
              </p>
              <div className="mb-4 max-h-64 overflow-y-auto rounded-md border border-neutral-200">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-neutral-50">
                    <tr className="text-left text-neutral-500">
                      <th className="px-2 py-1.5 font-normal">Category</th>
                      <th className="px-2 py-1.5 font-normal">Description</th>
                      <th className="px-2 py-1.5 text-right font-normal">Unit</th>
                      <th className="px-2 py-1.5 text-right font-normal">Qty</th>
                      <th className="px-2 py-1.5 text-right font-normal">Suggested rate</th>
                      {estimateNameById.size > 0 && <th className="px-2 py-1.5 font-normal">Project</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {proposedItems.map((item, i) => {
                      const catalogMatch = matchDescription(item.description, proposeCatalog);
                      return (
                        <tr key={i} className="border-t border-neutral-100">
                          <td className="px-2 py-1 text-neutral-500">{item.category}</td>
                          <td className="max-w-[24rem] truncate px-2 py-1" title={item.sourceQuote}>
                            {item.description}
                          </td>
                          <td className="px-2 py-1 text-right">{item.unit}</td>
                          <td className="px-2 py-1 text-right">
                            {item.qty}
                            {!item.qtyIsExplicit && (
                              <span className="ml-1 text-amber-600" title="Not stated in the source -- a placeholder, not a real quantity.">
                                *
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-1 text-right">
                            {catalogMatch ? (
                              <span
                                className="text-brand-navy"
                                title={`Matched to ${catalogMatch.source} catalog: "${catalogMatch.name}" -- verify before relying on it.`}
                              >
                                ${catalogMatch.unitCost.toFixed(2)}
                              </span>
                            ) : (
                              <span className="text-neutral-400">—</span>
                            )}
                          </td>
                          {estimateNameById.size > 0 && (
                            <td className="px-2 py-1 text-neutral-500">
                              {item.estimateId ? (estimateNameById.get(item.estimateId) ?? "Unknown estimate") : "Shared"}
                              {item.classificationUncertain && (
                                <span
                                  className="ml-1 text-amber-600"
                                  title="A second, independent AI pass disagreed with this classification -- verify carefully before committing."
                                >
                                  ⚠
                                </span>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <form action={commitScopeItemsAction.bind(null, estimateId, currentVersion.id, proposeDocument.id)}>
                <Button>Commit {proposedItems.length} draft line items</Button>
              </form>
            </div>
          )}
        </Card>
      )}

      <Card className="p-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Reconcile CAD Pull Sheet ↔ Excel quote
        </h2>
        <p className="mb-4 text-sm text-neutral-500">
          Cross-checks a CAD drawing&apos;s last-page Pull Sheet table against its matching Excel quote (the same
          booth workbook the Import above reads) -- matched by Part Number for BeMatrix hardware and by Sq. Ft. for
          Wall Panels, flagging anything that disagrees or exists on only one side. Read-only: nothing here changes
          any line item.
        </p>
        {cadDocuments.length === 0 || pricingScheduleDocuments.length === 0 ? (
          <Notice
            message="Upload both a CAD drawing (PDF) and its matching Excel quote on the Opportunity's Documents card first."
            actionHref={`/opportunities/${opportunityId}`}
            actionLabel="Go to Opportunity"
          />
        ) : (
          <form action={reconcilePullSheetAction} className="flex items-end gap-3">
            <div className="flex-1">
              <SelectField
                label="CAD drawing"
                name="cadDocumentId"
                options={cadDocuments.map((d) => ({ value: d.id, label: d.filename }))}
              />
            </div>
            <div className="flex-1">
              <SelectField
                label="Excel quote"
                name="excelDocumentId"
                options={pricingScheduleDocuments.map((d) => ({ value: d.id, label: d.filename }))}
              />
            </div>
            <Button variant="secondary">Reconcile</Button>
          </form>
        )}

        {reconcileResult && reconcileResult.status === "UNSUPPORTED" && (
          <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {reconcileResult.reason}
          </p>
        )}

        {reconcileResult && reconcileResult.status === "COMPLETE" && (
          <ReconciliationResultTable rows={reconcileResult.rows} />
        )}
      </Card>

      {previewPullSheetEnrichmentAction && applyPullSheetEnrichmentAction && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Enrich line items from CAD Pull Sheet
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Fills in the dimension a terse Excel description leaves out (e.g. &quot;1/3M X 1/2M FRAME&quot; →
            &quot;1/3M X 1/2M FRAME (310mm x 434mm)&quot;), matched to the already-imported line item by Part
            Number -- this only ever appends to an existing description, never creates a new line item or changes
            cost/qty.
          </p>
          {cadDocuments.length === 0 ? (
            <Notice
              message="Upload a CAD drawing (PDF) on the Opportunity's Documents card first."
              actionHref={`/opportunities/${opportunityId}`}
              actionLabel="Go to Opportunity"
            />
          ) : (
            <form action={previewPullSheetEnrichmentAction} className="flex items-end gap-3">
              <div className="flex-1">
                <SelectField
                  label="CAD drawing"
                  name="cadDocumentId"
                  defaultValue={enrichCadDocumentId ?? ""}
                  options={cadDocuments.map((d) => ({ value: d.id, label: d.filename }))}
                />
              </div>
              <Button variant="secondary">Preview enrichment</Button>
            </form>
          )}

          {enrichApplied !== null && (
            <p className="mt-4 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
              Updated {enrichApplied} line item{enrichApplied === 1 ? "" : "s"}.
            </p>
          )}

          {enrichResult && "status" in enrichResult && (
            <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {enrichResult.reason}
            </p>
          )}

          {enrichResult && !("status" in enrichResult) && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-sm text-neutral-700">
                <span className="font-medium">{enrichResult.proposals.length}</span> item
                {enrichResult.proposals.length === 1 ? "" : "s"} to enrich, {enrichResult.alreadyComplete} already
                complete, {enrichResult.noCadMatch} with no CAD match.
              </p>
              {enrichResult.proposals.length > 0 && (
                <>
                  <div className="mb-3 flex flex-col gap-2">
                    {enrichResult.proposals.map((p) => (
                      <div key={p.lineItemId} className="rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
                        <div className="text-neutral-500 line-through">{p.currentDescription}</div>
                        <div className="text-neutral-900">{p.proposedDescription}</div>
                      </div>
                    ))}
                  </div>
                  <form action={applyPullSheetEnrichmentAction}>
                    <input type="hidden" name="cadDocumentId" value={enrichCadDocumentId ?? ""} />
                    <Button>Apply {enrichResult.proposals.length} enrichment{enrichResult.proposals.length === 1 ? "" : "s"}</Button>
                  </form>
                </>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

const RECONCILIATION_STATUS_STYLE: Record<ReconciliationRow["status"], string> = {
  MATCHED: "border-green-200 bg-green-50 text-green-800",
  QTY_MISMATCH: "border-red-200 bg-red-50 text-red-800",
  AREA_MISMATCH: "border-red-200 bg-red-50 text-red-800",
  AMBIGUOUS: "border-amber-200 bg-amber-50 text-amber-800",
  ONLY_IN_CAD: "border-amber-200 bg-amber-50 text-amber-800",
  ONLY_IN_EXCEL: "border-amber-200 bg-amber-50 text-amber-800",
};

// Rows grouped MATCHED-last, most-actionable-first -- an estimator opening
// this report cares about what disagrees, not re-confirming the (usually
// large) majority that already lines up.
const RECONCILIATION_STATUS_ORDER: ReconciliationRow["status"][] = [
  "QTY_MISMATCH",
  "AREA_MISMATCH",
  "AMBIGUOUS",
  "ONLY_IN_CAD",
  "ONLY_IN_EXCEL",
  "MATCHED",
];

function ReconciliationResultTable({ rows }: { rows: ReconciliationRow[] }) {
  const sorted = [...rows].sort(
    (a, b) => RECONCILIATION_STATUS_ORDER.indexOf(a.status) - RECONCILIATION_STATUS_ORDER.indexOf(b.status),
  );
  const matchedCount = rows.filter((r) => r.status === "MATCHED").length;

  return (
    <div className="mt-4 border-t border-neutral-200 pt-4">
      <p className="mb-3 text-sm text-neutral-700">
        <span className="font-medium">{matchedCount}</span> matched, {rows.length - matchedCount} needing a look, out
        of {rows.length} total.
      </p>
      <div className="flex flex-col gap-2">
        {sorted.map((row, i) => (
          <div key={i} className={`rounded-md border px-3 py-2 text-sm ${RECONCILIATION_STATUS_STYLE[row.status]}`}>
            <span className="font-medium">{row.status.replace(/_/g, " ")}</span> — {row.detail}
          </div>
        ))}
      </div>
    </div>
  );
}

// "Type Totals" tab: a production/inventory pull-quantity rollup, not a
// client-facing view -- how many of each exact physical part are needed
// across the WHOLE estimate, merged across every booth/section, so the
// shop knows how much to pull from stock once the job is awarded (a part
// repeated across 6 booths shows one combined quantity here, unlike the
// Proposal PDF, which deliberately keeps booth-scoped items separate).
// Read-only; see buildTypeTotals for the actual rollup logic.
//
// Excludes Option/alternate sections the same way the Preview PDF modal's
// own category list already does (page.tsx's previewSections) -- an
// alternate hasn't been awarded, so it shouldn't count toward what
// production needs to pull.
function TypeTotalsTab({ version, categories }: { version: VersionWithSections; categories: Category[] }) {
  const baseSections = version.sections.filter((s) => s.optionId === null);
  const typeTotals = buildTypeTotals(baseSections, categories);

  if (typeTotals.length === 0) {
    return (
      <Card className="p-6">
        <p className="text-sm text-neutral-500">No material line items to total yet.</p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {typeTotals.map((group) => (
        <Card key={group.categoryName} className="p-6">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900">{group.categoryName}</h3>
            <span className="text-sm font-medium text-neutral-700">{money(group.totalCost)}</span>
          </div>
          <TypeTotalsMethodTable label="Rental" methodTotal={group.rental} />
          <TypeTotalsMethodTable label="Purchase" methodTotal={group.purchase} />
        </Card>
      ))}
    </div>
  );
}

// One acquisition-Method sub-table within a Type card (see TypeTotalsTab) --
// Rental (drawn from our own rental stock) vs. Purchase (bought fresh,
// including raw fabrication inputs like plywood/aluminum that never carry
// a Method tag at all). Omitted entirely when empty, rather than shown as
// an empty section, so a Type with only Purchase parts doesn't also show a
// bare "Rental" heading with nothing under it.
function TypeTotalsMethodTable({ label, methodTotal }: { label: string; methodTotal: MethodTotal }) {
  if (methodTotal.parts.length === 0) return null;
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</h4>
        <span className="text-xs font-medium text-neutral-500">{money(methodTotal.totalCost)}</span>
      </div>
      {methodTotal.families.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {methodTotal.families.map((family) => (
            <span
              key={family.label}
              className="rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-700"
              title={`${family.label} across every size/variant`}
            >
              {family.label}: {family.qty}
              {family.totalSqft !== undefined && ` · ${family.totalSqft.toFixed(1)} sqft`}
            </span>
          ))}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
            <tr>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Unit</th>
              <th className="px-3 py-2 text-right">Qty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {methodTotal.parts.map((part) => (
              <tr key={part.key}>
                <td className="px-3 py-2">{part.description}</td>
                <td className="px-3 py-2 text-neutral-500">{part.unit ?? "--"}</td>
                <td className="px-3 py-2 text-right font-medium">{part.qty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// "Review" tab: read-only/advisory audits of what's already in the
// estimate -- risk flags surfaced from source documents, categories that
// won't bucket correctly on the client-facing proposal, and scope
// coverage gaps. None of these mutate line items directly; they point at
// what to go fix elsewhere (mostly back in Line Items).
function ReviewTab({
  estimateId,
  opportunityId,
  riskFlags,
  categoryAudit,
  currentVersion,
  scopeDocuments,
  runCoverageAnalysisAction,
  coverageAnalysis,
  coverageGapsWithDocs,
  recategorized,
  recategorizeChecked,
  reconciliationDocuments,
  runReconciliationAction,
  reconciliation,
}: {
  estimateId: string;
  opportunityId: string;
  riskFlags: (DocumentSummary["riskFlags"][number] & { doc: { id: string; filename: string; mimeType: string } })[];
  categoryAudit: ReturnType<typeof auditLineItemCategories>;
  currentVersion: VersionWithSections;
  scopeDocuments: { id: string; filename: string }[];
  runCoverageAnalysisAction: ((formData: FormData) => void | Promise<void>) | null;
  coverageAnalysis: { generatedAt: string; lineItemCount: number; gaps: CoverageGap[] } | null;
  coverageGapsWithDocs: (CoverageGap & { doc: { id: string; filename: string; mimeType: string } })[];
  recategorized: number | null;
  recategorizeChecked: number;
  reconciliationDocuments: { id: string; filename: string }[];
  runReconciliationAction: ((formData: FormData) => void | Promise<void>) | null;
  reconciliation: ClientTemplateReconciliation | Error | null;
}) {
  const bidPackagesAwaitingReview = currentVersion.bidPackages.filter((p) => p.status === "QUOTE_RECEIVED");
  const hasAnyReview =
    riskFlags.length > 0 ||
    categoryAudit.issues.length > 0 ||
    bidPackagesAwaitingReview.length > 0 ||
    (scopeDocuments.length > 0 && runCoverageAnalysisAction) ||
    (reconciliationDocuments.length > 0 && runReconciliationAction);

  if (!hasAnyReview) {
    return (
      <div className="pt-2 text-sm text-neutral-500">
        Nothing to review yet -- risk flags and category issues show up here once documents are analyzed and line
        items are added.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {riskFlags.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Risk &amp; compliance flags
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Extracted from this job&apos;s analyzed documents — verify against the source before pricing or
            signing off around these terms.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {riskFlags.map((flag, i) => {
              const href = citationHref(opportunityId, flag.doc, flag, `/estimates/${estimateId}#risk-flag-${i}`);
              return (
                <li
                  key={i}
                  id={`risk-flag-${i}`}
                  className="flex items-start justify-between gap-3 rounded-md bg-amber-50 px-3 py-2"
                >
                  <span className="flex items-start gap-2 text-amber-900">
                    <span aria-hidden>⚠</span>
                    {flag.text}
                  </span>
                  {href ? (
                    <Link href={href} className="shrink-0 text-xs text-brand-navy hover:underline">
                      {flag.doc.filename} →
                    </Link>
                  ) : (
                    <span className="shrink-0 text-xs text-neutral-400">{flag.doc.filename}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {categoryAudit.issues.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Category review
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            These line items won&apos;t bucket correctly on the client-facing proposal — they&apos;ll fall
            into &quot;Other&quot; instead of their real category. Fix them here before sending.
          </p>
          {recategorized !== null && (
            <p className="mb-4 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900">
              Checked {recategorizeChecked} uncategorized line item{recategorizeChecked === 1 ? "" : "s"} and fixed{" "}
              {recategorized} using its source document&apos;s own category label.
              {recategorized < recategorizeChecked &&
                ` The remaining ${recategorizeChecked - recategorized} still need a manual category -- their source doesn't carry one this can resolve automatically.`}
            </p>
          )}
          <form
            action={recategorizeLineItemsAction.bind(null, estimateId, currentVersion.id)}
            className="mb-4"
            title="Re-checks every uncategorized line item against its source document's own category label (e.g. a Design Cost Estimate workbook's 'Wall Panels'/'BeMatrix' banners) -- catches rows imported before that mapping existed."
          >
            <Button variant="secondary">Recategorize using source labels</Button>
          </form>
          <ul className="flex flex-col gap-2 text-sm">
            {categoryAudit.issues.map((issue) => (
              <li
                key={issue.lineItemId}
                className="flex items-start justify-between gap-3 rounded-md bg-amber-50 px-3 py-2"
              >
                <span className="flex items-start gap-2 text-amber-900">
                  <span aria-hidden>⚠</span>
                  {issue.description}
                  {issue.reason === "orphaned" && (
                    <span className="text-amber-700"> — category &quot;{issue.category}&quot; no longer exists</span>
                  )}
                </span>
                <a href={`#line-item-${issue.lineItemId}`} className="shrink-0 text-xs text-brand-navy hover:underline">
                  {issue.sectionName}
                  {issue.groupLabel ? ` — ${issue.groupLabel}` : ""} →
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {categoryAudit.methodUnresolvedIssues.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            No Rental/Purchase/Custom Fabricated method yet
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            These line items sit on a flat category (e.g. &quot;Structure&quot;) that supports a method split, but
            neither their own text nor a component tag resolved one yet -- they still render fine, just without a
            Rental/Purchase/Custom Fabricated breakdown. Not a blocker; fix via the component tagging card above or
            a manual category change on the line item.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {categoryAudit.methodUnresolvedIssues.map((issue) => (
              <li
                key={issue.lineItemId}
                className="flex items-start justify-between gap-3 rounded-md bg-neutral-50 px-3 py-2"
              >
                <span className="flex items-start gap-2 text-neutral-700">
                  <span aria-hidden>·</span>
                  {issue.description}
                  <span className="text-neutral-400"> — {issue.category}</span>
                </span>
                <a href={`#line-item-${issue.lineItemId}`} className="shrink-0 text-xs text-brand-navy hover:underline">
                  {issue.sectionName}
                  {issue.groupLabel ? ` — ${issue.groupLabel}` : ""} →
                </a>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {bidPackagesAwaitingReview.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Vendor pricing
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            These bid packages have a vendor quote extracted but haven&apos;t been reviewed yet -- open each one to
            match its priced lines against this package&apos;s line items and apply what looks right.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {bidPackagesAwaitingReview.map((pkg) => (
              <li key={pkg.id} className="flex items-center justify-between gap-3 rounded-md bg-amber-50 px-3 py-2">
                <span className="flex items-center gap-2 text-amber-900">
                  <span aria-hidden>⚠</span>
                  {pkg.name}
                  {pkg.vendorName && <span className="text-amber-700"> — {pkg.vendorName}</span>}
                </span>
                <Link href={`/estimates/${estimateId}?tab=bid-packages`} className="shrink-0 text-xs text-brand-navy hover:underline">
                  Review →
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {currentVersion && scopeDocuments.length > 0 && runCoverageAnalysisAction && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Scope coverage
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Checks this version&apos;s line items against its scope documents for requirements that don&apos;t
            appear to be priced anywhere -- advisory only, never adds line items automatically. Verify every
            flag against the source before treating it as a real gap.
          </p>
          <form action={runCoverageAnalysisAction}>
            <SubmitButton pendingText={coverageAnalysis ? "Re-running…" : "Running…"} variant="secondary">
              {coverageAnalysis ? "Re-run coverage analysis" : "Run coverage analysis"}
            </SubmitButton>
          </form>

          {coverageAnalysis && (
            <div className="mt-4 border-t border-neutral-200 pt-4">
              <p className="mb-3 text-xs text-neutral-400">
                Generated {new Date(coverageAnalysis.generatedAt).toLocaleString()}, based on{" "}
                {coverageAnalysis.lineItemCount} line item(s) -- re-run after making changes to the estimate or
                its documents.
              </p>
              {coverageGapsWithDocs.length === 0 ? (
                <p className="text-sm text-neutral-500">No coverage gaps found.</p>
              ) : (
                <ul className="flex flex-col gap-2 text-sm">
                  {coverageGapsWithDocs.map((gap, i) => {
                    const href = citationHref(
                      opportunityId,
                      gap.doc,
                      gap,
                      `/estimates/${estimateId}#coverage-gap-${i}`,
                    );
                    return (
                      <li
                        key={i}
                        id={`coverage-gap-${i}`}
                        className="flex items-start justify-between gap-3 rounded-md bg-amber-50 px-3 py-2"
                      >
                        <span className="flex items-start gap-2 text-amber-900">
                          <span aria-hidden>⚠</span>
                          {gap.requirement}
                        </span>
                        {href ? (
                          <Link href={href} className="shrink-0 text-xs text-brand-navy hover:underline">
                            {gap.doc.filename} →
                          </Link>
                        ) : (
                          <span className="shrink-0 text-xs text-neutral-400">{gap.doc.filename}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </Card>
      )}

      {reconciliationDocuments.length > 0 && runReconciliationAction && (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Client template reconciliation
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            Compares this version&apos;s line items against the client&apos;s own RFP pricing template, booth
            by booth -- flags a booth with nothing priced at all, or missing an item category the client
            explicitly asks for. This never suggests a Unit Rate to fill into the client&apos;s template: our
            part-level engineering doesn&apos;t map cleanly onto the client&apos;s coarser line items (e.g.
            &quot;Complete Booth Build&quot;), so use these totals as a reference and price the template by
            hand.
          </p>
          <form action={runReconciliationAction} className="flex items-end gap-3">
            <div className="w-96">
              <SelectField
                label="Client pricing template document"
                name="documentId"
                options={reconciliationDocuments.map((d) => ({ value: d.id, label: d.filename }))}
              />
            </div>
            <SubmitButton pendingText="Reconciling…" variant="secondary">
              Run reconciliation
            </SubmitButton>
          </form>

          {reconciliation instanceof Error && (
            <p className="mt-4 border-t border-neutral-200 pt-4 text-sm text-red-700">{reconciliation.message}</p>
          )}

          {reconciliation && !(reconciliation instanceof Error) && (
            <div className="mt-4 flex flex-col gap-4 border-t border-neutral-200 pt-4">
              {reconciliation.sections.map((s) => (
                <div key={s.section} className="rounded-md border border-neutral-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-semibold text-neutral-900">{s.section}</span>
                    <span className="text-sm text-neutral-600">
                      {s.ourItemCount} line item{s.ourItemCount === 1 ? "" : "s"} priced -- {money(s.ourTotal)}
                    </span>
                  </div>
                  {s.missingSection && (
                    <p className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      <span aria-hidden>⚠</span> Client expects this booth priced, but nothing has been imported
                      for it yet.
                    </p>
                  )}
                  {s.categoryGaps.map((gap, i) => (
                    <p key={i} className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      <span aria-hidden>⚠</span> {gap}
                    </p>
                  ))}
                  <details className="text-sm text-neutral-500">
                    <summary className="cursor-pointer select-none">
                      Client&apos;s {s.clientItems.length} expected item{s.clientItems.length === 1 ? "" : "s"}
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1 pl-4">
                      {s.clientItems.map((item, i) => (
                        <li key={i}>
                          {item.description.split("\n")[0]} — {item.qty} {item.unit}
                        </li>
                      ))}
                    </ul>
                  </details>
                </div>
              ))}
              {reconciliation.addOnRows.length > 0 && (
                <p className="text-xs text-neutral-400">
                  The client&apos;s template also lists {reconciliation.addOnRows.length} standing rate-card item
                  {reconciliation.addOnRows.length === 1 ? "" : "s"} (alternate wall systems, add-on
                  components) not tied to a specific booth -- not checked against your booth pricing above.
                </p>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// "Proposal & Approval" tab: PDF preview, lock/approve lifecycle,
// generating a real Proposal record, change orders, and version
// history -- everything about turning this version into something sent
// to a client and tracked afterward.
function ProposalApprovalTab({
  estimateId,
  version,
  users,
  proposalTemplates,
  olderVersions,
}: {
  estimateId: string;
  version: VersionWithSections;
  users: { id: string; name: string }[];
  proposalTemplates: { id: string; name: string }[];
  olderVersions: VersionWithSections[];
}) {
  const approveVersionWithIds = approveVersionAction.bind(null, estimateId, version.id);
  const generateProposalWithIds = generateProposalAction.bind(null, estimateId, version.id);
  const createChangeOrderWithIds = createChangeOrderAction.bind(null, estimateId, version.id);

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-6">
        {version.isLocked ? (
          <div>
            <p className="mb-4 text-sm text-neutral-500">
              Margin target: {version.marginTargetPct.toFixed(1)}% (locked{" "}
              {version.lockedAt ? version.lockedAt.toISOString().slice(0, 16).replace("T", " ") : ""})
            </p>

            <div className="rounded-md border border-neutral-200 p-4">
              {!version.isApproved ? (
                users.length === 0 ? (
                  <Notice
                    message="Approving a version needs an approver on file, and there are no users yet."
                    actionHref="/admin/users/new"
                    actionLabel="Add a user"
                  />
                ) : (
                  <form action={approveVersionWithIds} className="flex items-end gap-3">
                    <div className="w-56">
                      <SelectField
                        label="Approved by"
                        name="approvedById"
                        required
                        options={users.map((u) => ({ value: u.id, label: u.name }))}
                      />
                    </div>
                    <Button variant="secondary">Approve version</Button>
                  </form>
                )
              ) : (
                <>
                  <p className="mb-3 text-sm text-neutral-500">
                    Approved by {version.approvedBy?.name ?? "unknown"}
                    {version.approvedAt
                      ? ` on ${version.approvedAt.toISOString().slice(0, 16).replace("T", " ")}`
                      : ""}
                  </p>
                  {proposalTemplates.length === 0 ? (
                    <Notice
                      message="Generating a proposal needs a branded template, and there are no templates yet."
                      actionHref="/catalog/proposal-templates/new"
                      actionLabel="Add a template"
                    />
                  ) : (
                    <form action={generateProposalWithIds} className="flex items-end gap-3">
                      <div className="w-56">
                        <SelectField
                          label="Proposal template"
                          name="templateId"
                          required
                          options={proposalTemplates.map((t) => ({ value: t.id, label: t.name }))}
                        />
                      </div>
                      <SubmitButton pendingText="Generating…" variant="secondary">
                        Generate proposal
                      </SubmitButton>
                    </form>
                  )}
                  {version.proposals.length > 0 && (
                    <ul className="mt-4 flex flex-col gap-1 border-t border-neutral-200 pt-3 text-sm">
                      {version.proposals.map((p) => (
                        <li key={p.id} className="flex items-center justify-between">
                          <Link href={`/proposals/${p.id}`} className="text-neutral-900 hover:underline">
                            Proposal {p.id.slice(0, 8)}
                          </Link>
                          <span className="text-neutral-500">
                            {p.signedAt ? "Signed" : p.sentAt ? "Sent" : "Draft"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <form action={createChangeOrderWithIds} className="mt-4 flex items-end gap-3 border-t border-neutral-200 pt-3">
                    <div className="flex-1">
                      <Field
                        label="Start a change order"
                        name="description"
                        placeholder="What's changing? e.g. Upgrade flooring"
                        required
                      />
                    </div>
                    <Button variant="secondary">Start change order</Button>
                  </form>
                  {version.changeOrdersAsBase.length > 0 && (
                    <ul className="mt-4 flex flex-col gap-1 border-t border-neutral-200 pt-3 text-sm">
                      {version.changeOrdersAsBase.map((co) => (
                        <li key={co.id} className="flex items-center justify-between">
                          <Link href={`/change-orders/${co.id}`} className="text-neutral-900 hover:underline">
                            {co.description}
                          </Link>
                          <span className="text-neutral-500">{co.status}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">
            Lock this version (in the header above) to unlock approval, proposal generation, and change orders.
          </p>
        )}
      </Card>

      {olderVersions.length > 0 && (
        <Card className="p-6">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Earlier versions
          </h2>
          <ul className="flex flex-col gap-2 text-sm">
            {olderVersions.map((v) => (
              <li key={v.id} className="flex items-center justify-between rounded-md bg-neutral-50 px-3 py-2">
                <span>
                  Version {v.versionNumber} {v.isLocked ? "· locked" : "· unlocked"}
                </span>
                <span className="font-medium">{money(v.grandTotal)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// "Cut List" tab: thin wrapper around the existing dedicated cut-list
// page -- that page is a substantial tool in its own right (material
// calculator, nesting, DXF export), so this stays a link-out rather than
// folding its whole UI inline. Kept as a tab (not a stray button) so it
// lives in the same navigation paradigm as everything else here.
function CutListTab({ estimateId, versionId }: { estimateId: string; versionId: string }) {
  return (
    <Card className="p-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Cut list</h2>
      <p className="mb-4 text-sm text-neutral-500">
        Material calculator, sheet-nesting optimization, printable cutting diagrams, and CNC DXF export for this
        estimate&apos;s fabrication -- a shop-floor planning tool, separate from this estimate&apos;s priced line
        items.
      </p>
      <Link
        href={`/estimates/${estimateId}/versions/${versionId}/cut-list`}
        className="text-sm font-medium text-brand-navy hover:underline"
      >
        Manage cut list →
      </Link>
    </Card>
  );
}

const APPLY_METHOD_LABELS: Record<string, string> = {
  single: "Single apply",
  group: "Bulk group",
  all_high_confidence: "All high-confidence",
  selected: "Selected (checkboxes)",
};

// The real, durable point-in-time audit trail for every vendor-match
// apply -- see VendorMatchApplyLog's own schema comment for why this is
// a separate table from BidPackage.matchResult (which only ever holds
// current state, and where an applied match now disappears from the
// active review view once it's been committed -- see this tab's own
// reason for existing). Every row is a snapshot taken at apply time, so
// it stays legible even after the LineItem/BidPackage/Document it
// references is later deleted -- targetDescription etc. are real
// stored text, not live joins that could go blank.
function HistoryTab({
  estimateId,
  isLocked,
  log,
  auditLog,
}: {
  estimateId: string;
  isLocked: boolean;
  log: Awaited<ReturnType<typeof getVendorMatchApplyLog>>;
  auditLog: LineItemAuditLogEntry[];
}) {
  return (
    <div className="flex flex-col gap-6">
      {log.length === 0 ? (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Vendor match apply history
          </h2>
          <p className="text-sm text-neutral-500">
            Nothing applied yet. Every vendor-match Apply click -- single row, bulk group, &quot;all high-confidence,&quot;
            or a hand-picked selection -- will show up here permanently, even after the estimate itself changes.
          </p>
        </Card>
      ) : (
        <Card className="p-6">
          <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Vendor match apply history
          </h2>
          <p className="mb-4 text-sm text-neutral-500">
            A permanent record of every vendor price applied to this estimate -- who, what, and when. Unlike the Bid
            Packages tab (which only shows current state), a row here never disappears, even if the line item it priced
            is later renamed, deleted, or re-priced.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="px-3 pb-1.5 font-normal">When</th>
                  <th className="px-3 pb-1.5 font-normal">Who</th>
                  <th className="px-3 pb-1.5 font-normal">How</th>
                  <th className="px-3 pb-1.5 font-normal">Bid package</th>
                  <th className="px-3 pb-1.5 font-normal">Applied to</th>
                  <th className="px-3 pb-1.5 font-normal">From vendor line(s)</th>
                  <th className="px-3 pb-1.5 text-right font-normal">Qty</th>
                  <th className="px-3 pb-1.5 text-right font-normal">Unit cost</th>
                  <th className="px-3 pb-1.5 text-right font-normal">Total</th>
                  <th className="px-3 pb-1.5 font-normal">Source document</th>
                </tr>
              </thead>
              <tbody>
                {log.map((entry) => (
                  <tr key={entry.id} className="border-t border-neutral-100 align-top">
                    <td className="whitespace-nowrap px-3 py-2 text-neutral-500">
                      {entry.createdAt.toLocaleString("en-US", {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="px-3 py-2">{entry.actor.name}</td>
                    <td className="px-3 py-2">{APPLY_METHOD_LABELS[entry.method] ?? entry.method}</td>
                    <td className="px-3 py-2 text-neutral-500">{entry.bidPackageName}</td>
                    <td className="px-3 py-2">
                      {entry.targetDescription}
                      {entry.targetSectionLabel && (
                        <span className="ml-1.5 text-xs text-neutral-400">{entry.targetSectionLabel}</span>
                      )}
                      {!entry.lineItemId && (
                        <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">
                          line item since deleted
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">
                      {entry.vendorLineDescriptions}
                      {entry.vendorLineCount > 1 && (
                        <span className="ml-1.5 text-xs text-neutral-400">({entry.vendorLineCount} lines)</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{entry.qty.toNumber()}</td>
                    <td className="px-3 py-2 text-right">{money(entry.unitCost)}</td>
                    <td className="px-3 py-2 text-right">{money(entry.totalCost)}</td>
                    <td className="px-3 py-2 text-neutral-500">
                      {entry.documentFilename}
                      {!entry.documentId && (
                        <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-700">deleted</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <LineItemChangeHistoryCard estimateId={estimateId} isLocked={isLocked} auditLog={auditLog} />
    </div>
  );
}

type LineItemAuditLogEntry = Prisma.LineItemAuditLogGetPayload<{ include: { actor: { select: { name: true } } } }>;

const AUDIT_ACTION_LABEL: Record<string, string> = { CREATE: "Created", UPDATE: "Updated", DELETE: "Deleted", RESTORE: "Restored" };
const AUDIT_ACTION_STYLE: Record<string, string> = {
  CREATE: "border-green-200 bg-green-50 text-green-800",
  UPDATE: "border-neutral-200 bg-neutral-50 text-neutral-700",
  DELETE: "border-red-200 bg-red-50 text-red-800",
  RESTORE: "border-blue-200 bg-blue-50 text-blue-800",
};

// Internal-only snapshot fields (see deleteLineItem's LineItemDeleteSnapshot)
// that restoreLineItemAction needs but that mean nothing to a person
// reading this list -- a raw cuid or a bare integer next to real fields
// like "category: Structure" would just read as noise.
const AUDIT_DETAIL_HIDDEN_FIELDS = new Set(["sectionId", "sortOrder"]);

function LineItemChangeHistoryCard({
  estimateId,
  isLocked,
  auditLog,
}: {
  estimateId: string;
  isLocked: boolean;
  auditLog: LineItemAuditLogEntry[];
}) {
  return (
    <Card className="p-6">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Line item change history</h2>
      <p className="mb-4 text-sm text-neutral-500">
        A permanent record of every line item created, edited, or deleted on this estimate -- who, what, and when. A
        deleted row&apos;s snapshot lives here even after the line item itself is gone. &quot;System/Import&quot; means an
        automated import or AI proposal, not a person clicking a button. Showing the most recent 200.
      </p>
      {auditLog.length === 0 ? (
        <p className="text-sm text-neutral-500">No line item changes recorded yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {(() => {
            // A DELETE whose original lineItemId shows up again on a later
            // RESTORE (restoreLineItem reuses the original id) has already
            // been put back -- don't offer Restore on it a second time.
            const restoredLineItemIds = new Set(
              auditLog.filter((e) => e.action === "RESTORE" && e.lineItemId).map((e) => e.lineItemId!),
            );

            return auditLog.map((entry) => {
              const snapshot =
                entry.detail && typeof entry.detail === "object" ? (entry.detail as Record<string, unknown>) : null;
              const canRestore =
                entry.action === "DELETE" &&
                !isLocked &&
                !!entry.lineItemId &&
                !restoredLineItemIds.has(entry.lineItemId) &&
                !!snapshot &&
                "sectionId" in snapshot;

              return (
                <div key={entry.id} className="rounded-md border border-neutral-200 px-3 py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-xs font-medium ${AUDIT_ACTION_STYLE[entry.action]}`}>
                      {AUDIT_ACTION_LABEL[entry.action] ?? entry.action}
                    </span>
                    <span className="font-medium">{entry.description}</span>
                    <span className="text-neutral-400">·</span>
                    <span className="text-neutral-500">{entry.actor?.name ?? "System/Import"}</span>
                    <span className="text-neutral-400">·</span>
                    <span className="text-neutral-500">
                      {entry.createdAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                    </span>
                    {canRestore && (
                      <form action={restoreLineItemAction.bind(null, estimateId, entry.id)} className="ml-auto">
                        <Button variant="secondary">Restore</Button>
                      </form>
                    )}
                  </div>
                  {entry.action === "UPDATE" && entry.detail && typeof entry.detail === "object" && (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs text-neutral-600">
                      {Object.entries(entry.detail as Record<string, { before: unknown; after: unknown }>).map(([field, change]) => (
                        <li key={field}>
                          <span className="font-medium">{field}</span>: {String(change.before ?? "—")} → {String(change.after ?? "—")}
                        </li>
                      ))}
                    </ul>
                  )}
                  {entry.action === "DELETE" && snapshot && (
                    <p className="mt-1 text-xs text-neutral-600">
                      {Object.entries(snapshot)
                        .filter(([field]) => !AUDIT_DETAIL_HIDDEN_FIELDS.has(field))
                        .map(([field, value]) => `${field}: ${value ?? "—"}`)
                        .join(" · ")}
                    </p>
                  )}
                  {entry.action === "RESTORE" && (
                    <p className="mt-1 text-xs text-neutral-600">Restored from the deletion above.</p>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}
    </Card>
  );
}
