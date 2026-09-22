import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { canViewDepartmentOversight } from "@/lib/department-access";
import { getGraphicsOrders, getWeeklyDeliveredCounts } from "@/lib/artwork-hub";
import {
  getVendorTurnaround,
  getRevisionRoundsDistribution,
  getExistingVsNewSplit,
  getShowComparison,
  jobDate,
} from "@/lib/graphics-analytics";
import { Card, Stat, EmptyState } from "@/components/ui";
import { PageShell } from "@/components/dashboard-shell";
import { BarBreakdown } from "@/components/bar-breakdown";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;
const THROUGHPUT_WEEKS = 12;

const RANGE_OPTIONS: { value: string; label: string; days: number | null }[] = [
  { value: "30", label: "Last 30 days", days: 30 },
  { value: "90", label: "Last 90 days", days: 90 },
  { value: "365", label: "Last 365 days", days: 365 },
  { value: "all", label: "All time", days: null },
];

export default async function GraphicsAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Whole-department trend/comparison data -- same restriction as the
  // dashboard's own "Department" tab, not every GR staff member. See
  // canViewDepartmentOversight's own comment.
  if (!canViewDepartmentOversight(user)) redirect("/departments/graphics");

  const { range } = await searchParams;
  const selectedRange = RANGE_OPTIONS.find((r) => r.value === range) ?? RANGE_OPTIONS[1];
  const now = new Date();
  const since = selectedRange.days ? new Date(now.getTime() - selectedRange.days * DAY_MS) : null;

  const [orders, vendorTurnaround, revisionDistribution, existingVsNew, weeklyDelivered] = await Promise.all([
    getGraphicsOrders(user, { includeArchived: true }),
    getVendorTurnaround(user, since),
    getRevisionRoundsDistribution(user, since),
    getExistingVsNewSplit(user, since),
    getWeeklyDeliveredCounts(user, THROUGHPUT_WEEKS),
  ]);

  const showComparison = getShowComparison(orders);

  // Two fixes in one line.
  //
  // `orders` now includes archived pieces, because this page already
  // reported on them everywhere else -- revision rounds and the
  // existing/new split come from graphics-analytics.ts, which has no
  // archive filter. One page was running two archive policies, and the
  // visible result was "Delivered this period: 0" sitting beside "921
  // pieces" on the same screen.
  //
  // And the window is jobDate, not updatedAt. updatedAt is when the ROW
  // was last touched, which for every imported piece is the day of the
  // import -- so a past show either vanished or all landed in whichever
  // week it was imported.
  const deliveredInRange = orders.filter(
    (o) => o.status === "DELIVERED_AT_SHOW" && (!since || jobDate(o) >= since),
  ).length;

  const turnaroundSampleTotal = vendorTurnaround.reduce((sum, v) => sum + v.sampleSize, 0);
  const avgTurnaroundDays =
    turnaroundSampleTotal > 0
      ? vendorTurnaround.reduce((sum, v) => sum + v.avgDays * v.sampleSize, 0) / turnaroundSampleTotal
      : null;

  const numericRevisionBuckets = revisionDistribution.slice(0, 3); // 0 / 1 / 2 rounds, excludes "Escalated"
  const revisionSampleTotal = numericRevisionBuckets.reduce((sum, b) => sum + b.count, 0);
  const avgRevisionRounds =
    revisionSampleTotal > 0
      ? numericRevisionBuckets.reduce((sum, b, i) => sum + i * b.count, 0) / revisionSampleTotal
      : null;

  const existingTotal = existingVsNew.existingCount + existingVsNew.newCount;
  const existingPct = existingTotal > 0 ? Math.round((existingVsNew.existingCount / existingTotal) * 100) : null;

  const vendorTurnaroundRows = vendorTurnaround.map((v) => ({
    label: v.vendorName,
    count: Math.round(v.avgDays * 10) / 10,
    href: `/departments/graphics/log?logVendor=${encodeURIComponent(v.vendorName)}`,
  }));

  return (
      <PageShell
        id="forgeos-graphics-analytics"
        title="Analytics"
        backHref="/departments/graphics"
        backLabel="Graphics"
      >
      <div className="flex flex-col gap-6">
        <div className="flex flex-wrap gap-2">
          {RANGE_OPTIONS.map((opt) => (
            <Link
              key={opt.value}
              href={`/departments/graphics/analytics?range=${opt.value}`}
              className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                opt.value === selectedRange.value
                  ? "border-brand-black bg-brand-black text-white"
                  : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat value={avgTurnaroundDays != null ? `${avgTurnaroundDays.toFixed(1)}d` : "—"} label="Avg vendor turnaround" />
          <Stat value={avgRevisionRounds != null ? avgRevisionRounds.toFixed(1) : "—"} label="Avg revision rounds" />
          <Stat value={existingPct != null ? `${existingPct}%` : "—"} label="Pieces reusing existing artwork" />
          <Stat value={String(deliveredInRange)} label="Delivered this period" />
        </div>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Throughput, last {THROUGHPUT_WEEKS} weeks
          </h2>
          <div className="flex h-16 items-end gap-2">
            {(() => {
              const CHART_HEIGHT_PX = 64;
              const max = Math.max(1, ...weeklyDelivered.map((w) => w.count));
              return weeklyDelivered.map((w) => (
                <div key={w.weekStart.toISOString()} className="flex flex-1 flex-col items-center justify-end gap-1">
                  <div
                    className="w-full rounded-t bg-brand-teal"
                    style={{ height: `${Math.max((w.count / max) * CHART_HEIGHT_PX, w.count > 0 ? 6 : 2)}px` }}
                    title={`${w.count} delivered, week of ${w.weekStart.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`}
                  />
                </div>
              ));
            })()}
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Card className="p-5">
            <BarBreakdown
              title="Vendor turnaround (avg days, production go-ahead → packaged)"
              rows={vendorTurnaroundRows}
              emptyMessage="No order in this range has both a production-go-ahead and packaged-ready event on record yet."
            />
          </Card>
          <Card className="p-5">
            <BarBreakdown
              title="Revision rounds"
              rows={revisionDistribution.map((b) => ({ label: b.label, count: b.count }))}
              emptyMessage="No orders in this range."
            />
          </Card>
        </div>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Existing vs. new artwork</h2>
          {existingTotal === 0 ? (
            <EmptyState message="No pieces in this range have been marked as reusing existing artwork or needing new design." />
          ) : (
            <>
              <div className="flex h-6 overflow-hidden rounded-md">
                <div
                  className="bg-brand-teal"
                  style={{ width: `${(existingVsNew.existingCount / existingTotal) * 100}%` }}
                  title={`Existing / rolled over: ${existingVsNew.existingCount}`}
                />
                <div
                  className="bg-brand-tangerine"
                  style={{ width: `${(existingVsNew.newCount / existingTotal) * 100}%` }}
                  title={`New design: ${existingVsNew.newCount}`}
                />
              </div>
              <div className="mt-2 flex gap-4 text-xs text-neutral-600">
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-brand-teal" />
                  Existing / rolled over — {existingVsNew.existingCount}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm bg-brand-tangerine" />
                  New design — {existingVsNew.newCount}
                </span>
                {existingVsNew.unsetCount > 0 && (
                  <span className="text-neutral-400">{existingVsNew.unsetCount} not yet set</span>
                )}
              </div>
            </>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">
            Show vs. show ({showComparison.length})
          </h2>
          {showComparison.length === 0 ? (
            <EmptyState message="No shows tracked yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-3">Show</th>
                    <th className="py-2 pr-3">Pieces</th>
                    <th className="py-2 pr-3">Existing</th>
                    <th className="py-2 pr-3">New</th>
                    {/* Existing + New rarely equals Pieces -- most imported
                        history has no existingGraphicsStatus at all (78 of
                        PGA 2026's 639, all 282 of Seatrade 2026). Without
                        this column the row just silently fails to add up,
                        which reads as a bug in the numbers rather than a
                        gap in the data. */}
                    <th className="py-2 pr-3">Not recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {showComparison.map((row) => (
                    <tr key={row.showId ?? "none"} className="border-b border-neutral-100">
                      <td className="py-2 pr-3 font-medium text-neutral-800">
                        {row.showId ? (
                          <Link href={`/shows/${row.showId}`} className="hover:underline">
                            {row.showName}
                          </Link>
                        ) : (
                          row.showName
                        )}
                      </td>
                      <td className="py-2 pr-3 tabular-nums">{row.totalPieces}</td>
                      <td className="py-2 pr-3 tabular-nums text-neutral-500">{row.existingCount}</td>
                      <td className="py-2 pr-3 tabular-nums text-neutral-500">{row.newCount}</td>
                      <td className="py-2 pr-3 tabular-nums text-neutral-400">
                        {row.totalPieces - row.existingCount - row.newCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <p className="text-xs text-neutral-400">
          SLA compliance rate isn&apos;t shown here -- slaDueAt is overwritten every time an order re-enters proof
          review, so there&apos;s no reliable historical record of whether a now-resolved order was ever overdue,
          only whether it&apos;s overdue right now (the dashboard&apos;s own SLA-overdue count).
        </p>
      </div>
      </PageShell>
  );
}
