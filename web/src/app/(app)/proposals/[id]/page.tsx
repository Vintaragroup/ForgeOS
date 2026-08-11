import { notFound, redirect } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { canAccessOpportunity } from "@/lib/opportunity-access";
import { sendProposalAction, signProposalAction } from "../actions";
import { extractBranding, extractDetailConfig } from "@/lib/proposal-branding";
import { BRAND, BRAND_ADDRESS_LINES } from "@/lib/brand";
import { Button, Card, Field, PageHeader } from "@/components/ui";

const SECTION_ACCENTS = [BRAND.navy, BRAND.teal, BRAND.tangerine, BRAND.tan];

function money(d: { toFixed(n: number): string }): string {
  return `$${d.toFixed(2)}`;
}

function moneyFromNumber(n: number): string {
  return `$${n.toFixed(2)}`;
}

type SectionWithItems = {
  id: string;
  name: string;
  groupLabel: string | null;
  lineItems: { id: string; description: string; qty: { toString(): string }; unit: string | null; totalCost: { toFixed(n: number): string; toString(): string } }[];
};

type RenderBlock =
  | { kind: "booth"; label: string; sections: SectionWithItems[] }
  | { kind: "standalone"; section: SectionWithItems };

// Mirrors proposal-pdf.tsx's buildRenderBlocks -- groups sections sharing
// a groupLabel (a booth/exhibit instance) under one shared heading,
// preserving each block's original relative order.
function buildRenderBlocks(sections: SectionWithItems[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const boothBlockIndex = new Map<string, number>();
  for (const section of sections) {
    if (section.groupLabel) {
      let index = boothBlockIndex.get(section.groupLabel);
      if (index === undefined) {
        index = blocks.length;
        boothBlockIndex.set(section.groupLabel, index);
        blocks.push({ kind: "booth", label: section.groupLabel, sections: [] });
      }
      (blocks[index] as { kind: "booth"; label: string; sections: SectionWithItems[] }).sections.push(section);
    } else {
      blocks.push({ kind: "standalone", section });
    }
  }
  return blocks;
}

function sectionSubtotal(section: SectionWithItems): number {
  return section.lineItems.reduce((sum, li) => sum + Number(li.totalCost.toString()), 0);
}

export default async function ProposalDetailPage(props: PageProps<"/proposals/[id]">) {
  const { id } = await props.params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const proposal = await db.proposal.findFirst({
    where: { id, deletedAt: null },
    include: {
      template: true,
      estimateVersion: {
        include: {
          estimate: { include: { opportunity: { include: { company: true } } } },
          // Base estimate sections only -- Option (alternates) pricing is
          // rendered separately once that UI exists (task #44).
          sections: { where: { optionId: null }, include: { lineItems: true } },
        },
      },
    },
  });
  if (!proposal) notFound();
  if (!(await canAccessOpportunity(user, proposal.estimateVersion.estimate.opportunityId))) notFound();

  const version = proposal.estimateVersion;
  const opportunity = version.estimate.opportunity;
  const sendWithId = sendProposalAction.bind(null, proposal.id);
  const signWithId = signProposalAction.bind(null, proposal.id);

  const { brandColor, logoUrl } = extractBranding(proposal.templateConfigSnapshot);
  const { mode: detailMode, sectionNames: detailSectionNames } = extractDetailConfig(proposal.templateConfigSnapshot);
  const isDetailed = (section: SectionWithItems) =>
    detailMode === "full" ||
    (section.groupLabel !== null && detailSectionNames.includes(section.groupLabel)) ||
    detailSectionNames.includes(section.name);

  const renderBody = (section: SectionWithItems) =>
    isDetailed(section) ? (
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-neutral-500">
            <th className="px-2 pb-1 font-normal">Description</th>
            <th className="px-2 pb-1 text-right font-normal">Qty</th>
            <th className="px-2 pb-1 text-right font-normal">Unit</th>
            <th className="px-2 pb-1 text-right font-normal">Total</th>
          </tr>
        </thead>
        <tbody>
          {section.lineItems.map((li) => (
            <tr key={li.id} className="border-t border-neutral-100">
              <td className="px-2 py-1.5">{li.description}</td>
              <td className="px-2 py-1.5 text-right">{li.qty.toString()}</td>
              <td className="px-2 py-1.5 text-right text-neutral-500">{li.unit ?? ""}</td>
              <td className="px-2 py-1.5 text-right">{money(li.totalCost)}</td>
            </tr>
          ))}
          <tr className="border-t border-neutral-200">
            <td colSpan={3} className="px-2 py-1.5 text-right text-sm font-semibold text-brand-navy">
              {section.name} total
            </td>
            <td className="px-2 py-1.5 text-right text-sm font-semibold text-brand-navy">
              {moneyFromNumber(sectionSubtotal(section))}
            </td>
          </tr>
        </tbody>
      </table>
    ) : (
      <div className="flex items-center justify-between px-2 py-1.5 text-sm">
        <span className="text-neutral-500">
          {section.lineItems.length} item{section.lineItems.length === 1 ? "" : "s"}
        </span>
        <span className="font-semibold text-brand-navy">{moneyFromNumber(sectionSubtotal(section))}</span>
      </div>
    );

  const blocks = buildRenderBlocks(version.sections.filter((section) => section.lineItems.length > 0));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={`Proposal — ${opportunity.showName}`}
        action={
          <div className="flex items-center gap-4 text-sm">
            <a
              href={`/proposals/${proposal.id}/pdf`}
              className="text-neutral-500 hover:text-neutral-900"
            >
              Download PDF
            </a>
            <Link href={`/estimates/${version.estimateId}`} className="text-neutral-500 hover:text-neutral-900">
              ← Back to estimate
            </Link>
          </div>
        }
      />

      <Card className="overflow-hidden p-0">
        <div
          className="h-1.5"
          style={{ backgroundColor: brandColor ?? "var(--brand-navy)" }}
        />
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <Image
                src="/brand/expo-logo-black.png"
                alt="Expo Convention Contractors"
                width={94}
                height={32}
                className="h-6 w-auto"
              />
              <div className="mt-1.5 text-[10px] leading-snug text-neutral-500">
                {BRAND_ADDRESS_LINES.map((line) => (
                  <div key={line}>{line}</div>
                ))}
              </div>
            </div>
            <span className="text-xs font-semibold uppercase tracking-widest text-brand-teal">
              Proposal
            </span>
          </div>
          <div className="mb-6 flex items-center justify-between border-b border-neutral-200 pb-6">
            <div>
              {logoUrl && <img src={logoUrl} alt="" className="mb-2 h-8" />}
              <div className="text-sm text-neutral-500">Prepared for {opportunity.company.name}</div>
              <div className="font-display text-2xl tracking-wide">{opportunity.showName}</div>
            </div>
            <div className="text-right text-sm">
              <div className="text-neutral-500">Proposal date</div>
              <div className="font-medium">{proposal.createdAt.toISOString().slice(0, 10)}</div>
            </div>
          </div>

          {blocks.map((block, blockIndex) => {
            const accent = SECTION_ACCENTS[blockIndex % SECTION_ACCENTS.length];
            if (block.kind === "standalone") {
              const section = block.section;
              return (
                <div key={section.id} className="mb-4">
                  <div className="mb-1 flex items-center gap-2 bg-brand-black px-2 py-1.5">
                    <span className="h-1.5 w-1.5" style={{ backgroundColor: accent }} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-white">
                      {section.name}
                    </span>
                  </div>
                  {renderBody(section)}
                </div>
              );
            }
            const boothTotal = block.sections.reduce((sum, s) => sum + sectionSubtotal(s), 0);
            return (
              <div key={block.label} className="mb-4">
                <div className="mb-1.5 flex items-center justify-between bg-brand-black px-2 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5" style={{ backgroundColor: accent }} />
                    <span className="text-xs font-semibold uppercase tracking-wide text-white">{block.label}</span>
                  </div>
                  <span className="text-xs font-semibold text-white">{moneyFromNumber(boothTotal)}</span>
                </div>
                <div className="ml-3 flex flex-col gap-3">
                  {block.sections.map((section) => (
                    <div key={section.id}>
                      <div className="mb-1 bg-neutral-100 px-2 py-1">
                        <span className="text-[9px] font-semibold uppercase tracking-wide text-neutral-700">
                          {section.name}
                        </span>
                      </div>
                      {renderBody(section)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          <div className="flex justify-end border-t border-neutral-200 pt-4">
            <div className="text-right">
              <div className="text-sm text-neutral-500">Grand total</div>
              <div className="text-2xl font-semibold text-brand-navy">{money(version.grandTotal)}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-neutral-500">Status</h2>
        <dl className="mb-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-neutral-500">Sent</dt>
            <dd>{proposal.sentAt ? proposal.sentAt.toISOString().slice(0, 16).replace("T", " ") : "Not sent"}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Signed</dt>
            <dd>
              {proposal.signedAt
                ? `${proposal.signedByName ?? "Unknown"}${proposal.signedByTitle ? `, ${proposal.signedByTitle}` : ""} — ${proposal.signedAt.toISOString().slice(0, 16).replace("T", " ")}`
                : "Not signed"}
            </dd>
          </div>
        </dl>
        {!proposal.sentAt && (
          <form action={sendWithId}>
            <Button>Send proposal</Button>
          </form>
        )}
        {proposal.sentAt && !proposal.signedAt && (
          <form action={signWithId} className="flex flex-wrap items-end gap-3">
            <Field label="Signer name" name="signedByName" required />
            <Field label="Title (optional)" name="signedByTitle" />
            <Button variant="secondary">Mark as signed</Button>
          </form>
        )}
      </Card>

      <p className="text-center text-[10px] font-medium uppercase tracking-widest text-neutral-400">
        Powered by ForgeOS
      </p>
    </div>
  );
}
