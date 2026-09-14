// Pure computation over an already-fetched GraphicsOrder[] (from
// getGraphicsOrders) -- shared by the Graphics dashboard (departments/
// graphics/page.tsx, Department-mode charts) and the Production Log page
// (departments/graphics/log/page.tsx, both its charts and its CSV export)
// so the two can't silently drift apart, matching getGraphicsOrders' own
// "one query definition" reasoning in artwork-hub.ts.

import type { ArtworkOrderStatus } from "@/generated/prisma/enums";
import type { GraphicsOrder } from "@/lib/artwork-hub";
import type { BarBreakdownRow } from "@/components/bar-breakdown";

// A piece hasn't had its artwork received yet while it's still sitting in
// the client's own hands -- same definition artwork-hub.ts's
// ART_NOT_YET_RECEIVED_STATUSES uses for the AE/PM rollup, duplicated here
// (rather than imported) since that constant isn't exported -- both are the
// judgment call "what counts as art received," kept in sync by being the
// same three statuses, not by a shared reference.
const ART_NOT_YET_RECEIVED_STATUSES: ReadonlySet<ArtworkOrderStatus> = new Set(["INVITED", "ORDER_DRAFTED", "REJECTED"]);

// Buckets the pipeline's 23 raw statuses into 6 stages a human actually
// thinks in -- the raw enum is unreadable as a chart with that many bars.
// Purely a navigation grouping for charts; the exact-status dropdown on the
// Production Log still exists for picking one precise value.
export const STATUS_GROUPS: Record<string, { label: string; statuses: ArtworkOrderStatus[] }> = {
  review: { label: "In review", statuses: ["INVITED", "ORDER_DRAFTED", "SUBMITTED", "UNDER_ART_REVIEW", "REJECTED"] },
  proofing: {
    label: "Proofing",
    statuses: [
      "ACCEPTED",
      "VENDOR_ASSIGNED",
      "PROOF_IN_PROGRESS",
      "PROOF_SUBMITTED",
      "EXPO_PROOF_CHECK",
      "PROOF_REVISION_REQUESTED",
      "ESCALATED",
      "PROOF_UNDER_REVIEW",
      "PROOF_APPROVED",
    ],
  },
  production: {
    label: "In production",
    statuses: ["PRODUCTION_GO_AHEAD", "IN_PRODUCTION", "RECEIVED_FROM_VENDOR", "INSPECTED", "REPRINT_REQUESTED"],
  },
  shipped: { label: "Packed & shipped", statuses: ["PACKAGED_READY", "SHIPPED_TO_SHOW"] },
  delivered: { label: "Delivered", statuses: ["DELIVERED_AT_SHOW"] },
  cancelled: { label: "Cancelled", statuses: ["CANCELLED"] },
};

// How many rows the Vendor/Client breakdown charts show before truncating
// -- these lists can run long (dozens of clients), and a chart with that
// many bars stops being scannable at a glance.
const TOP_N = 8;

// A Hub/hanging-sign piece (no opportunity -- see ArtworkOrder.showId's
// schema comment) is grouped under "PGA Hub" rather than its own show name,
// since there's no company to attribute it to.
export function clientLabelOf(o: GraphicsOrder): string {
  return o.opportunity ? o.opportunity.company.name : "PGA Hub";
}

export interface GraphicsBreakdowns {
  statusGroupRows: BarBreakdownRow[];
  vendorRows: BarBreakdownRow[];
  clientRows: BarBreakdownRow[];
}

// logHref lets each caller point drill-down rows at its own Production Log
// route (the two department-scoped dashboards this is shared with both
// happen to use the same one today, but this keeps that an explicit choice
// rather than a hardcoded path baked into shared code).
export function getGraphicsBreakdowns(orders: GraphicsOrder[], logHref = "/departments/graphics/log"): GraphicsBreakdowns {
  const statusGroupRows: BarBreakdownRow[] = Object.entries(STATUS_GROUPS).map(([key, group]) => ({
    label: group.label,
    count: orders.filter((o) => group.statuses.includes(o.status)).length,
    href: `${logHref}?logStatusGroup=${key}`,
  }));

  function topNRows(counts: Map<string, number>, param: string): BarBreakdownRow[] {
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_N)
      .map(([label, count]) => ({ label, count, href: `${logHref}?${param}=${encodeURIComponent(label)}` }));
  }

  const vendorCounts = new Map<string, number>();
  for (const o of orders) {
    const key = o.vendor?.name ?? "No vendor assigned";
    vendorCounts.set(key, (vendorCounts.get(key) ?? 0) + 1);
  }

  const clientCounts = new Map<string, number>();
  for (const o of orders) {
    const key = clientLabelOf(o);
    clientCounts.set(key, (clientCounts.get(key) ?? 0) + 1);
  }

  return {
    statusGroupRows,
    vendorRows: topNRows(vendorCounts, "logVendor"),
    clientRows: topNRows(clientCounts, "logClient"),
  };
}

export interface ClientSummaryRow {
  key: string;
  label: string;
  showLabel: string;
  href: string | null;
  totalPieces: number;
  artReceivedCount: number;
}

// Department-wide counterpart to artwork-hub.ts's getMyClientGraphicsSummary
// -- same "pieces / art received" shape, but every client in the
// department's queue, not just one person's assigned opportunities. Feeds
// the Graphics dashboard's Department-mode "All clients" table.
export function getAllClientsSummary(orders: GraphicsOrder[]): ClientSummaryRow[] {
  const byKey = new Map<string, ClientSummaryRow>();
  for (const o of orders) {
    const isHub = !o.opportunity;
    const key = isHub ? "__hub__" : o.opportunity!.id;
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        label: isHub ? "PGA Hub" : o.opportunity!.company.name,
        showLabel: isHub ? (o.show?.name ?? "—") : o.opportunity!.showName,
        href: isHub ? null : `/opportunities/${o.opportunity!.id}`,
        totalPieces: 0,
        artReceivedCount: 0,
      };
      byKey.set(key, row);
    }
    row.totalPieces += 1;
    if (!ART_NOT_YET_RECEIVED_STATUSES.has(o.status)) row.artReceivedCount += 1;
  }
  return [...byKey.values()].sort((a, b) => b.totalPieces - a.totalPieces);
}
