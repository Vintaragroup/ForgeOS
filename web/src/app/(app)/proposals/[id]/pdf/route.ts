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
          estimate: { include: { opportunity: { include: { company: true, primaryContact: true } }, taxRate: true } },
          sections: { where: { optionId: null }, include: { lineItems: true } },
        },
      },
    },
  });
  if (!proposal) notFound();
  if (!(await canAccessOpportunity(user, proposal.estimateVersion.estimate.opportunityId))) notFound();

  const version = proposal.estimateVersion;
  const opportunity = version.estimate.opportunity;
  const { brandColor, logoUrl } = extractBranding(proposal.templateConfigSnapshot);
  const professionalServices = extractProfessionalServices(proposal.templateConfigSnapshot);
  const termsAndConditions = extractTermsAndConditions(proposal.templateConfigSnapshot);
  const paymentMethodNote = extractPaymentMethodNote(proposal.templateConfigSnapshot);
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
        templateName: proposal.template.name,
        brandColor,
        logoUrl,
        proposalDate: proposal.createdAt,
        timeline,
        venue,
        scopeSummary,
        sections: version.sections,
        professionalServices,
        termsAndConditions,
        paymentMethodNote,
        taxRate,
        grandTotal: version.grandTotal,
        sentAt: proposal.sentAt,
        signedAt: proposal.signedAt,
        signedByName: proposal.signedByName,
        signedByTitle: proposal.signedByTitle,
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
