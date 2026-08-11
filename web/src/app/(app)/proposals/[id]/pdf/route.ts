import { notFound } from "next/navigation";
import { renderToBuffer } from "@react-pdf/renderer";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { extractBranding, extractDetailConfig } from "@/lib/proposal-branding";
import { ProposalPdfDocument } from "@/lib/proposal-pdf";

export async function GET(_request: Request, { params }: RouteContext<"/proposals/[id]/pdf">) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) notFound();

  const proposal = await db.proposal.findFirst({
    where: { id, deletedAt: null },
    include: {
      template: true,
      estimateVersion: {
        include: {
          estimate: { include: { opportunity: { include: { company: true } } } },
          sections: { where: { optionId: null }, include: { lineItems: true } },
        },
      },
    },
  });
  if (!proposal) notFound();
  if (!(await canAccessOpportunity(user, proposal.estimateVersion.estimate.opportunityId))) notFound();

  const version = proposal.estimateVersion;
  const opportunity = version.estimate.opportunity;
  const { brandColor } = extractBranding(proposal.templateConfigSnapshot);
  const { mode, sectionNames } = extractDetailConfig(proposal.templateConfigSnapshot);

  const buffer = await renderToBuffer(
    ProposalPdfDocument({
      data: {
        companyName: opportunity.company.name,
        showName: opportunity.showName,
        templateName: proposal.template.name,
        brandColor,
        proposalDate: proposal.createdAt,
        sections: version.sections,
        grandTotal: version.grandTotal,
        sentAt: proposal.sentAt,
        signedAt: proposal.signedAt,
        signedByName: proposal.signedByName,
        signedByTitle: proposal.signedByTitle,
        detailMode: mode,
        detailSectionNames: sectionNames,
      },
    }),
  );

  const filename = `proposal-${opportunity.showName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pdf`;

  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
