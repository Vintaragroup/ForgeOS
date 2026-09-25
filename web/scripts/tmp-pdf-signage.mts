import { renderToBuffer } from "@react-pdf/renderer";
import { getDocumentProxy } from "unpdf";
import { db } from "@/lib/db";
import { extractBranding, extractPaymentMethodNote, extractProfessionalServices, extractTermsAndConditions } from "@/lib/proposal-branding";
import { getProposalCoverInfo } from "@/lib/proposal-timeline";
import { taxRateLabel } from "@/lib/tax-rate";
import { ProposalPdfDocument } from "@/lib/proposal-pdf";

const version = await db.estimateVersion.findFirstOrThrow({
  where: { estimateId: "cmubciuk0000004l2fytqqiux" },
  orderBy: { versionNumber: "desc" },
  include: {
    estimate: { include: { opportunity: { include: { company: true, primaryContact: true } }, taxRate: true } },
    sections: { where: { optionId: null }, include: { lineItems: { where: { isDraft: false } }, categoryDescriptions: true } },
    categoryMarginOverrides: true,
  },
});
const categories = await db.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });
const summaryRows = await db.estimateCategorySummary.findMany({ where: { estimateVersionId: version.id }, include: { category: { select: { name: true } } } });
const template = await db.proposalTemplate.findFirstOrThrow({ where: { deletedAt: null } });
const opp = version.estimate.opportunity;
const { brandColor, logoUrl } = extractBranding({ brandingConfig: template.brandingConfig });
const { timeline, venue, scopeSummary } = await getProposalCoverInfo(opp.id);
const buffer = await renderToBuffer(ProposalPdfDocument({ data: {
  companyName: opp.company.name, companyAddress: opp.company.billingAddress,
  contactName: opp.primaryContact?.name ?? null, contactEmail: opp.primaryContact?.email ?? null,
  showName: opp.showName, templateName: template.name, brandColor, logoUrl, proposalDate: new Date(),
  timeline, venue, scopeSummary, sections: version.sections, categories,
  hidePricingCategoryNames: new Set<string>(), summaryCategoryNames: new Set<string>(),
  categorySummaries: new Map(summaryRows.filter((r) => r.summary).map((r) => [r.category.name, r.summary!])),
  showCost: false,
  professionalServices: extractProfessionalServices({ layoutConfig: template.layoutConfig }),
  termsAndConditions: extractTermsAndConditions({ layoutConfig: template.layoutConfig }),
  paymentMethodNote: extractPaymentMethodNote({ layoutConfig: template.layoutConfig }),
  taxRate: version.estimate.taxRate ? { label: taxRateLabel(version.estimate.taxRate), rate: version.estimate.taxRate.rate.toNumber() } : null,
  marginTargetPct: version.marginTargetPct, categoryMarginOverrides: version.categoryMarginOverrides,
  sentAt: null, signedAt: null, signedByName: null, signedByTitle: null,
} } as never));
const pdf = await getDocumentProxy(new Uint8Array(buffer));
for (let p = 1; p <= pdf.numPages; p += 1) {
  const c = await (await pdf.getPage(p)).getTextContent();
  const items = (c.items as { str: string; transform: number[] }[])
    .filter((i) => typeof i.str === "string" && i.str.trim())
    .map((i) => ({ y: Math.round(792 - i.transform[5]), x: Math.round(i.transform[4]), s: i.str.trim() }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  for (let k = 0; k < items.length; k += 1) {
    if (!/frame|SIGNAGE|HANGING|printed fabric/i.test(items[k].s)) continue;
    const near = items.slice(k, k + 4).map((i) => i.s).join("  |  ");
    console.log(`p${p}  ${near}`);
  }
}
process.exit(0);
