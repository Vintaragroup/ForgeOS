import { describeRouting } from "@/lib/artwork-routing";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
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

  const { logClient, logStatus, logStatusGroup, logVendor, logMaterial } = await searchParams;

  const orders = await getGraphicsOrders(user);

  const distinctClients = [...new Set(orders.map(clientLabelOf))].sort();
  const distinctVendors = [...new Set(orders.flatMap((o) => (o.vendor ? [o.vendor.name] : [])))].sort();
  const distinctMaterials = [...new Set(orders.flatMap((o) => (o.material ? [o.material] : [])))].sort();
  const distinctStatuses = [...new Set(orders.map((o) => o.status))].sort();

  const productionLogOrders = orders.filter((o) => {
    if (logClient && clientLabelOf(o) !== logClient) return false;
    if (logStatus && o.status !== logStatus) return false;
    if (logStatusGroup && !(STATUS_GROUPS[logStatusGroup]?.statuses.includes(o.status) ?? false)) return false;
    if (logVendor && o.vendor?.name !== logVendor) return false;
    if (logMaterial && o.material !== logMaterial) return false;
    return true;
  });

  // Charts are computed from the FULL order set, not productionLogOrders --
  // they're a navigation surface into a filter, not a live summary of
  // whatever's already filtered. Every row's own href replaces the filter
  // entirely (a fresh "show me all of X"), rather than merging with
  // whatever's currently applied.
  const { statusGroupRows, vendorRows, clientRows } = getGraphicsBreakdowns(orders);

  const hasActiveFilter = Boolean(logClient || logStatus || logStatusGroup || logVendor || logMaterial);
  const exportQuery = new URLSearchParams();
  if (logClient) exportQuery.set("logClient", logClient);
  if (logStatus) exportQuery.set("logStatus", logStatus);
  if (logStatusGroup) exportQuery.set("logStatusGroup", logStatusGroup);
  if (logVendor) exportQuery.set("logVendor", logVendor);
  if (logMaterial) exportQuery.set("logMaterial", logMaterial);
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
            <EmptyState message="No graphic pieces match these filters." />
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
                  {productionLogOrders.map((order) => (
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
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
