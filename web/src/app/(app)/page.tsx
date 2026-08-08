import Link from "next/link";
import { getDashboardData } from "@/lib/dashboard";
import { Card, EmptyState, PageHeader, Stat, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  ESTIMATING: "Estimating",
  WON: "Won",
  LOST: "Lost",
};

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function ProposalStatusChip({ sentAt, signedAt }: { sentAt: Date | null; signedAt: Date | null }) {
  if (signedAt) return <StatusChip tone="good">Signed</StatusChip>;
  if (sentAt) return <StatusChip tone="info">Sent</StatusChip>;
  return <StatusChip tone="neutral">Draft</StatusChip>;
}

export default async function DashboardPage() {
  const { pipeline, upcomingDeadlines, recentProposals } = await getDashboardData();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Dashboard" />

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Pipeline
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(STAGE_LABELS).map(([stage, label]) => (
            <Stat key={stage} value={String(pipeline.byStage[stage] ?? 0)} label={label} />
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Upcoming deadlines (next 30 days)
        </h2>
        {upcomingDeadlines.length === 0 ? (
          <EmptyState message="Nothing due in the next 30 days." />
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {upcomingDeadlines.map((deadline) => (
                <li key={`${deadline.workOrderId}-${deadline.kind}`}>
                  <Link
                    href={`/projects/${deadline.projectId}`}
                    className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                  >
                    <div>
                      <div className="font-medium">{deadline.kind}</div>
                      <div className="text-sm text-neutral-500">{deadline.label}</div>
                    </div>
                    <div className="text-sm">
                      {deadline.overdue ? (
                        <StatusChip tone="critical">Overdue — {fmtDate(deadline.date)}</StatusChip>
                      ) : (
                        <span className="text-neutral-500">{fmtDate(deadline.date)}</span>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Recent proposals
        </h2>
        {recentProposals.length === 0 ? (
          <EmptyState message="No proposals yet." />
        ) : (
          <Card>
            <ul className="divide-y divide-neutral-200">
              {recentProposals.map((proposal) => {
                const opportunity = proposal.estimateVersion.estimate.opportunity;
                return (
                  <li key={proposal.id}>
                    <Link
                      href={`/proposals/${proposal.id}`}
                      className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                    >
                      <div>
                        <div className="font-medium">{opportunity.showName}</div>
                        <div className="text-sm text-neutral-500">{opportunity.company.name}</div>
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
    </div>
  );
}
