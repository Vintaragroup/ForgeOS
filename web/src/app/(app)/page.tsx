import Link from "next/link";
import { getDashboardData } from "@/lib/dashboard";
import { getAdminAnalytics } from "@/lib/admin-analytics";
import { getCurrentUser } from "@/lib/auth";
import { Card, LinkButton, Notice, PageHeader, Stat, StatusChip } from "@/components/ui";

export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  ESTIMATING: "Estimating",
  WON: "Won",
  LOST: "Lost",
};

const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  ADMIN: "Admin",
  EMPLOYEE: "Employee",
};

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function fmtPct(pct: number | null) {
  return pct === null ? "—" : `${pct.toFixed(0)}%`;
}

function fmtUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function ProposalStatusChip({ sentAt, signedAt }: { sentAt: Date | null; signedAt: Date | null }) {
  if (signedAt) return <StatusChip tone="good">Signed</StatusChip>;
  if (sentAt) return <StatusChip tone="info">Sent</StatusChip>;
  return <StatusChip tone="neutral">Draft</StatusChip>;
}

// One dashboard for everyone, not two -- the old /admin page duplicated
// this same Pipeline stat row behind an extra click and a role check most
// users don't have. Admin-only sections render inline below instead, and
// only get fetched when the viewer is actually an admin.
export default async function DashboardPage() {
  const [{ pipeline, upcomingDeadlines, recentProposals }, user] = await Promise.all([
    getDashboardData(),
    getCurrentUser(),
  ]);
  const isAdmin = user?.systemRole === "ADMIN" || user?.systemRole === "SUPER_ADMIN";
  const adminStats = isAdmin ? await getAdminAnalytics() : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Dashboard"
        noBack
        action={<LinkButton href="/opportunities/new">New opportunity</LinkButton>}
      />

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Pipeline
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Object.entries(STAGE_LABELS).map(([stage, label]) => (
            <Link key={stage} href={`/opportunities?stage=${stage}`} className="block">
              <Stat
                value={String(pipeline.byStage[stage] ?? 0)}
                label={label}
                className="transition-colors hover:border-brand-teal"
              />
            </Link>
          ))}
        </div>
        {adminStats && (
          <p className="mt-2 text-sm text-neutral-500">
            Win rate: {fmtPct(adminStats.pipeline.winRatePct)} ({adminStats.pipeline.closedCount} closed
            opportunit{adminStats.pipeline.closedCount === 1 ? "y" : "ies"})
          </p>
        )}
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Upcoming deadlines (next 30 days)
        </h2>
        {upcomingDeadlines.length === 0 ? (
          <Notice
            message="Nothing due in the next 30 days. Once a job is won, its production timeline shows up here."
            actionHref="/opportunities"
            actionLabel="View opportunities"
          />
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
          <Notice
            message="No proposals yet. Generate one from an approved estimate version."
            actionHref="/estimates"
            actionLabel="View estimates"
          />
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

      {adminStats && (
        <div className="flex flex-col gap-8 border-t border-neutral-200 pt-8">
          <h2 className="-mb-4 text-xs font-semibold uppercase tracking-widest text-brand-navy">
            Admin overview
          </h2>

          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Estimates &amp; proposals
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat value={String(adminStats.estimates.current)} label="Active estimate versions" />
              <Stat value={String(adminStats.estimates.locked)} label="Locked" />
              <Stat value={String(adminStats.estimates.approved)} label="Approved" />
              <Stat value={String(adminStats.proposals.total)} label="Proposals generated" />
            </div>
            <p className="mt-2 text-sm text-neutral-500">
              {adminStats.proposals.sent} sent, {adminStats.proposals.signed} signed — sign rate{" "}
              {fmtPct(adminStats.proposals.signRatePct)}
            </p>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Cost variance
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat value={String(adminStats.costVariance.lineItemCount)} label="Line items with actuals" />
              <Stat value={fmtUsd(adminStats.costVariance.estimatedTotal)} label="Estimated" />
              <Stat value={fmtUsd(adminStats.costVariance.actualTotal)} label="Actual" />
              <Stat
                value={`${adminStats.costVariance.variance >= 0 ? "+" : ""}${fmtUsd(adminStats.costVariance.variance)}`}
                label="Variance (actual − estimated)"
              />
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Users
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat value={String(adminStats.users.total)} label="Total" />
              {Object.entries(ROLE_LABELS).map(([role, label]) => (
                <Stat key={role} value={String(adminStats.users.byRole[role] ?? 0)} label={label} />
              ))}
            </div>
            <p className="mt-2 text-sm">
              <Link href="/admin/users" className="text-brand-navy hover:underline">
                Manage users →
              </Link>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
