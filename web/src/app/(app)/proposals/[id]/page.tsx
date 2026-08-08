import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { sendProposalAction, signProposalAction } from "../actions";
import { extractBranding } from "@/lib/proposal-branding";
import { Button, Card, Field, PageHeader } from "@/components/ui";

function money(d: { toFixed(n: number): string }): string {
  return `$${d.toFixed(2)}`;
}

export default async function ProposalDetailPage(props: PageProps<"/proposals/[id]">) {
  const { id } = await props.params;
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

  const version = proposal.estimateVersion;
  const opportunity = version.estimate.opportunity;
  const sendWithId = sendProposalAction.bind(null, proposal.id);
  const signWithId = signProposalAction.bind(null, proposal.id);

  const { brandColor, logoUrl } = extractBranding(proposal.templateConfigSnapshot);

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

      <Card className="p-6" style={brandColor ? { borderTopWidth: 4, borderTopColor: brandColor } : undefined}>
        <div className="mb-6 flex items-center justify-between">
          <div>
            {logoUrl && <img src={logoUrl} alt="" className="mb-2 h-8" />}
            <div className="text-sm text-neutral-500">{opportunity.company.name}</div>
            <div className="text-lg font-semibold">{opportunity.showName}</div>
          </div>
          <div className="text-right text-sm">
            <div className="text-neutral-500">Template</div>
            <div className="font-medium">{proposal.template.name}</div>
          </div>
        </div>

        <table className="mb-6 w-full text-sm">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-1 font-normal">Section</th>
              <th className="pb-1 font-normal">Description</th>
              <th className="pb-1 text-right font-normal">Total</th>
            </tr>
          </thead>
          <tbody>
            {version.sections.flatMap((section) =>
              section.lineItems.map((li) => (
                <tr key={li.id} className="border-t border-neutral-100">
                  <td className="py-1.5 text-neutral-500">{section.name}</td>
                  <td className="py-1.5">{li.description}</td>
                  <td className="py-1.5 text-right">{money(li.totalCost)}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>

        <div className="flex justify-end border-t border-neutral-200 pt-4">
          <div className="text-right">
            <div className="text-sm text-neutral-500">Grand total</div>
            <div className="text-2xl font-semibold">{money(version.grandTotal)}</div>
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
    </div>
  );
}
