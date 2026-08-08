import Link from "next/link";
import { getAdminAnalytics } from "@/lib/admin-analytics";
import { LinkButton, PageHeader, Stat } from "@/components/ui";

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

function fmtPct(pct: number | null) {
  return pct === null ? "—" : `${pct.toFixed(0)}%`;
}

function fmtUsd(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

export default async function AdminDashboardPage() {
  const stats = await getAdminAnalytics();

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Admin"
        action={<LinkButton href="/admin/users">Manage users</LinkButton>}
      />

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Pipeline
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(STAGE_LABELS).map(([stage, label]) => (
            <Stat key={stage} value={String(stats.pipeline.byStage[stage] ?? 0)} label={label} />
          ))}
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          Win rate: {fmtPct(stats.pipeline.winRatePct)} ({stats.pipeline.closedCount} closed
          opportunit{stats.pipeline.closedCount === 1 ? "y" : "ies"})
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Estimates &amp; proposals
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat value={String(stats.estimates.current)} label="Active estimate versions" />
          <Stat value={String(stats.estimates.locked)} label="Locked" />
          <Stat value={String(stats.estimates.approved)} label="Approved" />
          <Stat value={String(stats.proposals.total)} label="Proposals generated" />
        </div>
        <p className="mt-2 text-sm text-neutral-500">
          {stats.proposals.sent} sent, {stats.proposals.signed} signed — sign rate{" "}
          {fmtPct(stats.proposals.signRatePct)}
        </p>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Cost variance
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat value={String(stats.costVariance.lineItemCount)} label="Line items with actuals" />
          <Stat value={fmtUsd(stats.costVariance.estimatedTotal)} label="Estimated" />
          <Stat value={fmtUsd(stats.costVariance.actualTotal)} label="Actual" />
          <Stat
            value={`${stats.costVariance.variance >= 0 ? "+" : ""}${fmtUsd(stats.costVariance.variance)}`}
            label="Variance (actual − estimated)"
          />
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Users
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat value={String(stats.users.total)} label="Total" />
          {Object.entries(ROLE_LABELS).map(([role, label]) => (
            <Stat key={role} value={String(stats.users.byRole[role] ?? 0)} label={label} />
          ))}
        </div>
        <p className="mt-2 text-sm">
          <Link href="/admin/users" className="text-neutral-900 hover:underline">
            Manage users →
          </Link>
        </p>
      </div>
    </div>
  );
}
