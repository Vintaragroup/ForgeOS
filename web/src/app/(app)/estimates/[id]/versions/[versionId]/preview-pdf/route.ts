// Format-check preview for a still-in-progress (not yet locked/approved)
// EstimateVersion -- generateProposal() in proposal-service.ts deliberately
// gates the real Proposal record behind lock+approval (that's the
// finalized-numbers guarantee), but estimators still want to see how the
// branded template will render while they're actively editing. This route
// renders the same ProposalPdfDocument directly from live version data,
// without creating any Proposal row, so it can be hit any number of times
// from an unlocked, still-changing version.
import { notFound } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import {
  extractBranding,
  extractPaymentMethodNote,
  extractProfessionalServices,
  extractTermsAndConditions,
} from "@/lib/proposal-branding";
import { getProposalCoverInfo } from "@/lib/proposal-timeline";
import { taxRateLabel } from "@/lib/tax-rate";
import { ProposalPdfDocument } from "@/lib/proposal-pdf";

export async function GET(
  request: Request,
  { params }: RouteContext<"/estimates/[id]/versions/[versionId]/preview-pdf">,
) {
  const { id, versionId } = await params;
  const url = new URL(request.url);
  const templateId = url.searchParams.get("templateId");
  if (!templateId) return new Response("Missing templateId", { status: 400 });

  // Ephemeral, per-export view options from the Preview PDF modal
  // (proposal-preview-modal.tsx) -- comma-separated Category ids, never
  // persisted anywhere. categoryOrder reorders the `categories` array
  // below before it's handed to ProposalPdfDocument (aggregateByCategory/
  // buildTopLevelCategoryViews in proposal-view-model.ts already take
  // their own ordering straight from whatever array they're given, so no
  // changes needed there); hidePricing/summary get resolved to Category
  // NAMES once below, since ProposalPdfDocument's own bucketing keys on
  // name, not id.
  const categoryOrderIds = (url.searchParams.get("categoryOrder") ?? "").split(",").filter(Boolean);
  const hidePricingIds = new Set((url.searchParams.get("hidePricing") ?? "").split(",").filter(Boolean));
  const summaryIds = new Set((url.searchParams.get("summary") ?? "").split(",").filter(Boolean));

  const user = await getCurrentUser();
  if (!user) notFound();

  const [version, categories, categorySummaryRows] = await Promise.all([
    db.estimateVersion.findFirst({
      where: { id: versionId, estimateId: id },
      include: {
        estimate: { include: { opportunity: { include: { company: true, primaryContact: true } }, taxRate: true } },
        // isDraft: false -- a draft line item is deliberately excluded from
        // version.grandTotal (estimate-service.ts's computeSectionTotal)
        // until a human confirms it, and this document's own Grand Total
        // (proposal-pdf.tsx's documentGrandTotal, computed from these same
        // sections) needs to agree with that same rule. Without this
        // filter here, a real job's preview once showed thousands of
        // dollars of itemized draft subtotals with nothing confirmed yet
        // to back them.
        sections: { where: { optionId: null }, include: { lineItems: { where: { isDraft: false } } } },
        categoryMarginOverrides: true,
      },
    }),
    db.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } }),
    // Top tier of the three-level Proposal PDF copy system -- see
    // EstimateCategorySummary's own schema comment. versionId is already
    // known from params, so this doesn't need to wait on the version
    // query above.
    db.estimateCategorySummary.findMany({
      where: { estimateVersionId: versionId },
      include: { category: { select: { name: true } } },
    }),
  ]);
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  const template = await db.proposalTemplate.findUnique({ where: { id: templateId } });
  if (!template) notFound();

  // categoryOrder reorders by id (what the modal's own reorder buttons
  // track); anything not named keeps its original relative sortOrder,
  // appended after the named ones -- so an unmodified request (no
  // categoryOrder param at all) is a no-op, identical to today's order.
  const orderedCategories = categoryOrderIds.length
    ? [...categories].sort((a, b) => {
        const ai = categoryOrderIds.indexOf(a.id);
        const bi = categoryOrderIds.indexOf(b.id);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return 1;
        if (bi === -1) return -1;
        return ai - bi;
      })
    : categories;
  const hidePricingCategoryNames = new Set(
    orderedCategories.filter((c) => hidePricingIds.has(c.id)).map((c) => c.name),
  );
  const summaryCategoryNames = new Set(orderedCategories.filter((c) => summaryIds.has(c.id)).map((c) => c.name));
  const categorySummaries = new Map(
    categorySummaryRows.filter((r) => r.summary).map((r) => [r.category.name, r.summary!]),
  );

  const opportunity = version.estimate.opportunity;
  const { brandColor, logoUrl } = extractBranding({ brandingConfig: template.brandingConfig });
  const professionalServices = extractProfessionalServices({ layoutConfig: template.layoutConfig });
  const termsAndConditions = extractTermsAndConditions({ layoutConfig: template.layoutConfig });
  const paymentMethodNote = extractPaymentMethodNote({ layoutConfig: template.layoutConfig });
  const { timeline, venue, scopeSummary } = await getProposalCoverInfo(opportunity.id);
  const taxRate = version.estimate.taxRate
    ? { label: taxRateLabel(version.estimate.taxRate), rate: version.estimate.taxRate.rate.toNumber() }
    : null;

  const buffer = await renderToBuffer(
    ProposalPdfDocument({
      data: {
        companyName: opportunity.company.name,
        companyAddress: opportunity.company.billingAddress,
        contactName: opportunity.primaryContact?.name ?? null,
        contactEmail: opportunity.primaryContact?.email ?? null,
        showName: opportunity.showName,
        templateName: template.name,
        brandColor,
        logoUrl,
        proposalDate: new Date(),
        timeline,
        venue,
        scopeSummary,
        sections: version.sections,
        categories: orderedCategories,
        hidePricingCategoryNames,
        summaryCategoryNames,
        categorySummaries,
        // Internal, still-editing document -- an estimator sanity-checking
        // margin math needs to see cost next to the marked-up price, never
        // just the price alone. See ProposalPdfData's own comment.
        showCost: true,
        professionalServices,
        termsAndConditions,
        paymentMethodNote,
        taxRate,
        marginTargetPct: version.marginTargetPct,
        categoryMarginOverrides: version.categoryMarginOverrides,
        sentAt: null,
        signedAt: null,
        signedByName: null,
        signedByTitle: null,
      },
    }),
  );

  const filename = `preview-${opportunity.showName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
