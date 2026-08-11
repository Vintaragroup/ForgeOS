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
import { extractBranding } from "@/lib/proposal-branding";
import { ProposalPdfDocument } from "@/lib/proposal-pdf";

export async function GET(
  request: Request,
  { params }: RouteContext<"/estimates/[id]/versions/[versionId]/preview-pdf">,
) {
  const { id, versionId } = await params;
  const url = new URL(request.url);
  const templateId = url.searchParams.get("templateId");
  if (!templateId) return new Response("Missing templateId", { status: 400 });
  const detailMode = url.searchParams.get("detail") === "full" ? "full" : "summary";
  const detailSectionNames = url.searchParams.getAll("detailSections");

  const user = await getCurrentUser();
  if (!user) notFound();

  const version = await db.estimateVersion.findFirst({
    where: { id: versionId, estimateId: id },
    include: {
      estimate: { include: { opportunity: { include: { company: true } } } },
      sections: { where: { optionId: null }, include: { lineItems: true } },
    },
  });
  if (!version) notFound();
  if (!(await canAccessOpportunity(user, version.estimate.opportunityId))) notFound();

  const template = await db.proposalTemplate.findUnique({ where: { id: templateId } });
  if (!template) notFound();

  const opportunity = version.estimate.opportunity;
  const { brandColor } = extractBranding({ brandingConfig: template.brandingConfig });

  const buffer = await renderToBuffer(
    ProposalPdfDocument({
      data: {
        companyName: opportunity.company.name,
        showName: opportunity.showName,
        templateName: template.name,
        brandColor,
        proposalDate: new Date(),
        sections: version.sections,
        grandTotal: version.grandTotal,
        sentAt: null,
        signedAt: null,
        signedByName: null,
        signedByTitle: null,
        detailMode,
        detailSectionNames,
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
