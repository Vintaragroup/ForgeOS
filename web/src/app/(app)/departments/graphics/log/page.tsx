import { describeRouting } from "@/lib/artwork-routing";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { db } from "@/lib/db";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { getGraphicsOrders } from "@/lib/artwork-hub";
import { STATUS_GROUPS, clientLabelOf, getGraphicsBreakdowns } from "@/lib/graphics-breakdowns";
import { PageHeader, Card, StatusChip, EmptyState, SelectField, Button } from "@/components/ui";
import { OrderIdentity } from "@/components/artwork-order-identity";
import { BarBreakdown } from "@/components/bar-breakdown";

// Same "always fresh" reasoning as the Graphics landing dashboard this page
// was split out of.
export const dynamic = "force-dynamic";

// Tone map for the table's status chip -- every status not listed here
// (the bulk of the pipeline's mid-proof states) reads as neutral, which is
// the right default for "just moving through the normal steps, nothing to
// flag."
const PRODUCTION_LOG_STATUS_TONE: Record<string, "neutral" | "info" | "warning" | "good" | "critical"> = {
  ESCALATED: "critical",
  CANCELLED: "critical",
  REJECTED: "warning",
  REPRINT_REQUESTED: "warning",
  DELIVERED_AT_SHOW: "good",
  PACKAGED_READY: "good",
};

export default async function GraphicsProductionLogPage({
  searchParams,
}: {
  searchParams: Promise<{
    logClient?: string;
    logStatus?: string;
    logStatusGroup?: string;
    logVendor?: string;
    logMaterial?: string;
    logShow?: string;
    logArchived?: string;
  }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  const isGrDept = canAccessArtworkOrdersViaDepartment(user);
  // The full production log is Graphics-department (or admin) content
  // only -- an Account Executive gets their own summary rollup on the
  // landing dashboard instead (see departments/graphics/page.tsx), not
  // this deep-dive.
  if (!isGrDept && !isAdmin) redirect("/departments/graphics");

  const { logClient, logStatus, logStatusGroup, logVendor, logMaterial, logShow, logArchived } = await searchParams;
  // Off by default: the log is a live work surface first.
  const includeArchived = logArchived === "1";

  const orders = await getGraphicsOrders(user, { includeArchived });

  const distinctClients = [...new Set(orders.map(clientLabelOf))].sort();
  const distinctVendors = [...new Set(orders.flatMap((o) => (o.vendor ? [o.vendor.name] : [])))].sort();
  const distinctMaterials = [...new Set(orders.flatMap((o) => (o.material ? [o.material] : [])))].sort();
  const distinctStatuses = [...new Set(orders.map((o) => o.status))].sort();
  // A piece reaches its show either directly or through its opportunity --
  // the same two paths the Hub reads.
  const showOf = (o: (typeof orders)[number]) => o.show?.name ?? o.opportunity?.show?.name ?? null;
  const distinctShows = [...new Set(orders.flatMap((o) => (showOf(o) ? [showOf(o)!] : [])))].sort();
  // Counted separately, because when the toggle is off `orders` holds no
  // archived rows to count. Without this the page can say "0 of 0" while
  // 921 finished pieces sit behind a checkbox nobody knows to tick.
  const archivedCount = await db.artworkOrder.count({
    where: {
      deletedAt: null,
      archivedAt: { not: null },
      ...(isGrDept ? {} : { opportunity: opportunityAccessWhere(user) }),
    },
  });

  const productionLogOrders = orders.filter((o) => {
    if (logClient && clientLabelOf(o) !== logClient) return false;
    if (logStatus && o.status !== logStatus) return false;
    if (logStatusGroup && !(STATUS_GROUPS[logStatusGroup]?.statuses.includes(o.status) ?? false)) return false;
    if (logVendor && o.vendor?.name !== logVendor) return false;
    if (logMaterial && o.material !== logMaterial) return false;
    if (logShow && showOf(o) !== logShow) return false;
    return true;
  });

  // Charts are computed from the FULL order set, not productionLogOrders --
  // they're a navigation surface into a filter, not a live summary of
  // The table renders every filtered row into the DOM, which is fine at a
  // few hundred and not at 1,200 -- the count with past shows included.
  // Capped rather than paginated: this page's job is "find the piece I'm
  // thinking of", which the filters above do, and the CSV export already
  // carries the complete set for anyone who wants all of it.
  const ROW_CAP = 200;
  const visibleOrders = productionLogOrders.slice(0, ROW_CAP);
  const hiddenRowCount = productionLogOrders.length - visibleOrders.length;

  // whatever's already filtered. Every row's own href replaces the filter
  // entirely (a fresh "show me all of X"), rather than merging with
  // whatever's currently applied.
  const { statusGroupRows, vendorRows, clientRows } = getGraphicsBreakdowns(orders);

  const hasActiveFilter = Boolean(logClient || logStatus || logStatusGroup || logVendor || logMaterial || logShow || includeArchived);
  const exportQuery = new URLSearchParams();
  if (logClient) exportQuery.set("logClient", logClient);
  if (logStatus) exportQuery.set("logStatus", logStatus);
  if (logStatusGroup) exportQuery.set("logStatusGroup", logStatusGroup);
  if (logVendor) exportQuery.set("logVendor", logVendor);
  if (logMaterial) exportQuery.set("logMaterial", logMaterial);
  if (logShow) exportQuery.set("logShow", logShow);
  if (includeArchived) exportQuery.set("logArchived", "1");
  const exportHref = `/departments/graphics/log/export${exportQuery.toString() ? `?${exportQuery}` : ""}`;

  return (
    <>
      <PageHeader title="Production log" backHref="/departments/graphics" backLabel="Graphics" />
      <div className="flex flex-col gap-6">
        <Card className="p-5">
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <BarBreakdown title="By status" rows={statusGroupRows} />
            <BarBreakdown title="By vendor" rows={vendorRows} emptyMessage="No vendor assigned yet." />
            <BarBreakdown title="By client" rows={clientRows} />
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">
              Production log ({productionLogOrders.length} of {orders.length})
            </h2>
            <Link href={exportHref} className="text-sm font-medium text-neutral-600 hover:underline">
              Export CSV{hasActiveFilter ? " (filtered)" : ""} →
            </Link>
          </div>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-48">
              <SelectField
                label="Client"
                name="logClient"
                defaultValue={logClient ?? ""}
                options={[{ value: "", label: "All clients" }, ...distinctClients.map((c) => ({ value: c, label: c }))]}
              />
            </div>
            <div className="min-w-44">
              <SelectField
                label="Status"
                name="logStatus"
                defaultValue={logStatus ?? ""}
                options={[
                  { value: "", label: "All statuses" },
                  ...distinctStatuses.map((s) => ({ value: s, label: s.replaceAll("_", " ") })),
                ]}
              />
            </div>
            <div className="min-w-40">
              <SelectField
                label="Vendor"
                name="logVendor"
                defaultValue={logVendor ?? ""}
                options={[{ value: "", label: "All vendors" }, ...distinctVendors.map((v) => ({ value: v, label: v }))]}
              />
            </div>
            <div className="min-w-48">
              <SelectField
                label="Material"
                name="logMaterial"
                defaultValue={logMaterial ?? ""}
                options={[{ value: "", label: "All materials" }, ...distinctMaterials.map((m) => ({ value: m, label: m }))]}
              />
            </div>
            <div className="min-w-48">
              <SelectField
                label="Show"
                name="logShow"
                defaultValue={logShow ?? ""}
                options={[{ value: "", label: "All shows" }, ...distinctShows.map((sh) => ({ value: sh, label: sh }))]}
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm">
              <input type="checkbox" name="logArchived" value="1" defaultChecked={includeArchived} className="h-4 w-4" />
              Include past shows
              {archivedCount > 0 && <span className="text-neutral-500">({archivedCount})</span>}
            </label>
            <Button variant="secondary" type="submit">
              Apply
            </Button>
            {hasActiveFilter && (
              <Link href="/departments/graphics/log" className="text-sm text-neutral-500 hover:underline">
                Clear
              </Link>
            )}
          </form>
          {productionLogOrders.length === 0 ? (
            <EmptyState
              message={
                includeArchived
                  ? "No graphic pieces match these filters."
                  : "No live graphic pieces match these filters. Tick \u201cInclude past shows\u201d to search finished work too."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="py-2 pr-3">Client</th>
                    <th className="py-2 pr-3">Piece</th>
                    <th className="py-2 pr-3">Material</th>
                    <th className="py-2 pr-3">Produced by</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Art due</th>
                    <th className="py-2 pr-3">In hand</th>
                    <th className="py-2 pr-3">Designer</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleOrders.map((order) => (
                    <tr key={order.id} className="border-b border-neutral-100">
                      <td className="py-2 pr-3">
                        <Link href={`/artwork/${order.id}`} className="flex items-center gap-2 hover:underline">
                          <OrderIdentity order={order} />
                        </Link>
                      </td>
                      <td className="py-2 pr-3">{order.graphicCode ?? "—"}</td>
                      <td className="py-2 pr-3">{order.material ?? "—"}</td>
                      <td className="py-2 pr-3">{describeRouting(order.routings)}</td>
                      <td className="py-2 pr-3">
                        <StatusChip tone={PRODUCTION_LOG_STATUS_TONE[order.status] ?? "neutral"}>
                          {order.status.replaceAll("_", " ")}
                        </StatusChip>
                      </td>
                      <td className="py-2 pr-3">
                        {order.artDueDate ? order.artDueDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {order.inHandDate ? order.inHandDate.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—"}
                      </td>
                      <td className="py-2 pr-3">{order.designer?.name ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {hiddenRowCount > 0 && (
                <p className="mt-3 text-xs text-neutral-500">
                  Showing the first {ROW_CAP} of {productionLogOrders.length}. Narrow the filters above to find a
                  specific piece, or export the CSV for the complete list.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
