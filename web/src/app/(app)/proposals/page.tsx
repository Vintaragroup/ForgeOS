import Link from "next/link";
import { db } from "@/lib/db";
import { Card, EmptyState, PageHeader, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

function ProposalStatusChip({ sentAt, signedAt }: { sentAt: Date | null; signedAt: Date | null }) {
  if (signedAt) return <StatusChip tone="good">Signed</StatusChip>;
  if (sentAt) return <StatusChip tone="info">Sent</StatusChip>;
  return <StatusChip tone="neutral">Draft</StatusChip>;
}

export default async function ProposalsPage() {
  const proposals = await db.proposal.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      template: true,
      estimateVersion: {
        include: { estimate: { include: { opportunity: { include: { company: true } } } } },
      },
    },
  });

  return (
    <div>
      <PageHeader title="Proposals" />
      {proposals.length === 0 ? (
        <EmptyState message="No proposals yet. Generate one from an approved, locked estimate version." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {proposals.map((proposal) => {
              const opportunity = proposal.estimateVersion.estimate.opportunity;
              return (
                <li key={proposal.id}>
                  <Link
                    href={`/proposals/${proposal.id}`}
                    className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                  >
                    <div>
                      <div className="font-medium">{opportunity.showName}</div>
                      <div className="text-sm text-neutral-500">
                        {opportunity.company.name} · {proposal.template.name}
                      </div>
                    </div>
                    <ProposalStatusChip sentAt={proposal.sentAt} signedAt={proposal.signedAt} />
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
