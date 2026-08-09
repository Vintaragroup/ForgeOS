import { redirect } from "next/navigation";
import { getReportsData } from "@/lib/reports";
import { getCurrentUser } from "@/lib/auth";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

const STAGE_LABELS: Record<string, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  ESTIMATING: "Estimating",
  WON: "Won",
};

function fmtPct(pct: number | null, digits = 0) {
  return pct === null ? "—" : `${pct.toFixed(digits)}%`;
}

function fmtMonth(month: string) {
  const [year, m] = month.split("-");
  return new Date(Number(year), Number(m) - 1, 1).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
  });
}

// B8: plain-CSS visualizations, no charting library -- bars sized with
// inline width/height percentages against each section's own max, same
// spirit as the dashboard's Stat tiles rather than an embedded chart widget.
export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { funnel, winRateByShow, marginTrend } = await getReportsData(user);

  const funnelMax = funnel[0]?.reached || 1;
  const marginValues = marginTrend.map((m) => m.avgMarginPct);
  const marginMax = Math.max(1, ...marginValues.map((v) => Math.abs(v)));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Reports" />

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Pipeline conversion
        </h2>
        <p className="mb-3 text-sm text-neutral-500">
          How many opportunities have ever reached each stage, and the conversion rate from the
          stage before it.
        </p>
        {funnel[0]?.reached === 0 ? (
          <EmptyState message="No opportunities yet." />
        ) : (
          <Card className="p-5">
            <div className="flex flex-col gap-3">
              {funnel.map((row) => (
                <div key={row.stage} className="flex items-center gap-4">
                  <div className="w-24 shrink-0 text-sm font-medium text-neutral-700">
                    {STAGE_LABELS[row.stage]}
                  </div>
                  <div className="h-6 flex-1 rounded-sm bg-neutral-100">
                    <div
                      className="h-full rounded-sm bg-brand-teal"
                      style={{ width: `${funnelMax === 0 ? 0 : (row.reached / funnelMax) * 100}%` }}
                    />
                  </div>
                  <div className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {row.reached}
                  </div>
                  <div className="w-16 shrink-0 text-right text-sm tabular-nums text-neutral-500">
                    {fmtPct(row.conversionFromPrevPct)}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Win rate by show
        </h2>
        <p className="mb-3 text-sm text-neutral-500">
          Closed opportunities (won or lost), grouped by trade show — top 10 by volume.
        </p>
        {winRateByShow.length === 0 ? (
          <EmptyState message="No closed opportunities yet." />
        ) : (
          <Card className="p-5">
            <div className="flex flex-col gap-3">
              {winRateByShow.map((row) => (
                <div key={row.showName} className="flex items-center gap-4">
                  <div className="w-40 shrink-0 truncate text-sm font-medium text-neutral-700">
                    {row.showName}
                  </div>
                  <div className="flex h-6 flex-1 overflow-hidden rounded-sm bg-neutral-100">
                    <div
                      className="h-full bg-brand-teal-light"
                      style={{ width: `${(row.won / row.total) * 100}%` }}
                    />
                    <div
                      className="h-full bg-red-300"
                      style={{ width: `${(row.lost / row.total) * 100}%` }}
                    />
                  </div>
                  <div className="w-24 shrink-0 text-right text-sm tabular-nums text-neutral-500">
                    {row.won}W / {row.lost}L
                  </div>
                  <div className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {fmtPct(row.winRatePct)}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex items-center gap-4 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-brand-teal-light" /> Won
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-2.5 rounded-sm bg-red-300" /> Lost
              </span>
            </div>
          </Card>
        )}
      </section>

      <section>
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
          Margin trend
        </h2>
        <p className="mb-3 text-sm text-neutral-500">
          Average gross margin % across current estimate versions, by the month they were created.
        </p>
        {marginTrend.length === 0 ? (
          <EmptyState message="No estimates yet." />
        ) : (
          <Card className="p-5">
            <div className="flex h-40 items-end gap-2">
              {marginTrend.map((row) => (
                <div key={row.month} className="flex flex-1 flex-col items-center gap-1.5">
                  <div className="text-xs font-medium tabular-nums text-neutral-600">
                    {row.avgMarginPct.toFixed(0)}%
                  </div>
                  <div className="flex w-full flex-1 items-end">
                    <div
                      className="w-full rounded-t-sm bg-brand-navy"
                      style={{ height: `${Math.max(4, (Math.abs(row.avgMarginPct) / marginMax) * 100)}%` }}
                      title={`${row.count} version${row.count === 1 ? "" : "s"}`}
                    />
                  </div>
                  <div className="text-xs text-neutral-500">{fmtMonth(row.month)}</div>
                </div>
              ))}
            </div>
          </Card>
        )}
      </section>
    </div>
  );
}
