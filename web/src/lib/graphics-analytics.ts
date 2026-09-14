// Trend/comparison reads for the Graphics dashboard's Analytics view
// (departments/graphics/analytics/page.tsx) -- distinct from
// graphics-breakdowns.ts's point-in-time snapshots (BarBreakdown rows for
// the dashboard/Production Log) and artwork-hub.ts's own queries. Every
// function here is gated the same way at the CALLER (the Analytics page
// itself, via canViewDepartmentOversight) -- these don't re-check access,
// same division of responsibility as getGraphicsOrders/
// getWeeklyDeliveredCounts already establish.
//
// One metric from the original plan is deliberately NOT here: "SLA
// compliance rate over time." ArtworkOrder.slaDueAt is a live field,
// overwritten every time an order re-enters EXPO_PROOF_CHECK -- there's no
// persisted record of whether a now-resolved order was EVER overdue while
// it sat there, only whether it's overdue right now (the dashboard's own
// slaOverdueOrders snapshot). Building a historical trend from that would
// mean inventing precision the data doesn't actually have. Revisit only if
// a real "went overdue" event gets logged going forward.

import { db } from "@/lib/db";
import type { SystemRole } from "@/generated/prisma/enums";
import { canAccessArtworkOrdersViaDepartment } from "@/lib/department-access";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import type { GraphicsOrder } from "@/lib/artwork-hub";

type AnalyticsUser = { id: string; systemRole: SystemRole; departmentCode: string | null };

function artworkOrderAccessWhere(user: AnalyticsUser) {
  return {
    deletedAt: null,
    ...(canAccessArtworkOrdersViaDepartment(user) ? {} : { opportunity: opportunityAccessWhere(user) }),
  };
}

export interface VendorTurnaround {
  vendorName: string;
  avgDays: number;
  sampleSize: number;
}

// "Turnaround" = days from an order's PRODUCTION_GO_AHEAD event to its
// PACKAGED_READY event -- the stretch of the pipeline a vendor is actually
// responsible for, not the whole client-facing proof cycle before it.
// Requires BOTH events to exist for an order to count, so a piece bulk-
// imported directly into a later status (no event history) is correctly
// excluded rather than silently guessed at.
export async function getVendorTurnaround(user: AnalyticsUser, since: Date | null): Promise<VendorTurnaround[]> {
  const events = await db.artworkOrderEvent.findMany({
    where: {
      toStatus: { in: ["PRODUCTION_GO_AHEAD", "PACKAGED_READY"] },
      ...(since ? { createdAt: { gte: since } } : {}),
      artworkOrder: artworkOrderAccessWhere(user),
    },
    select: {
      artworkOrderId: true,
      toStatus: true,
      createdAt: true,
      artworkOrder: { select: { vendor: { select: { name: true } } } },
    },
  });

  const byOrder = new Map<string, { goAheadAt?: Date; packagedAt?: Date; vendorName: string | null }>();
  for (const e of events) {
    let entry = byOrder.get(e.artworkOrderId);
    if (!entry) {
      entry = { vendorName: e.artworkOrder.vendor?.name ?? null };
      byOrder.set(e.artworkOrderId, entry);
    }
    if (e.toStatus === "PRODUCTION_GO_AHEAD" && (!entry.goAheadAt || e.createdAt < entry.goAheadAt)) {
      entry.goAheadAt = e.createdAt;
    }
    if (e.toStatus === "PACKAGED_READY" && (!entry.packagedAt || e.createdAt < entry.packagedAt)) {
      entry.packagedAt = e.createdAt;
    }
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const byVendor = new Map<string, number[]>();
  for (const entry of byOrder.values()) {
    if (!entry.goAheadAt || !entry.packagedAt || !entry.vendorName) continue;
    if (entry.packagedAt < entry.goAheadAt) continue;
    const days = (entry.packagedAt.getTime() - entry.goAheadAt.getTime()) / DAY_MS;
    const list = byVendor.get(entry.vendorName) ?? [];
    list.push(days);
    byVendor.set(entry.vendorName, list);
  }

  return [...byVendor.entries()]
    .map(([vendorName, days]) => ({
      vendorName,
      avgDays: days.reduce((sum, d) => sum + d, 0) / days.length,
      sampleSize: days.length,
    }))
    .sort((a, b) => a.avgDays - b.avgDays);
}

export interface RevisionRoundsBucket {
  label: string;
  count: number;
}

// Bucketed straight off ArtworkOrder.revisionRound -- a live field, no
// event-log reconstruction needed. "Escalated (unresolved)" is a distinct
// bucket for orders CURRENTLY in ESCALATED status -- see
// transitionArtworkOrder's own comment: hitting the revision cap holds
// revisionRound at 2 rather than incrementing to 3, so an escalation isn't
// otherwise distinguishable from "capped out at 2 rounds, not escalated"
// by revisionRound alone.
export async function getRevisionRoundsDistribution(
  user: AnalyticsUser,
  since: Date | null,
): Promise<RevisionRoundsBucket[]> {
  const orders = await db.artworkOrder.findMany({
    where: { ...artworkOrderAccessWhere(user), ...(since ? { createdAt: { gte: since } } : {}) },
    select: { revisionRound: true, status: true },
  });

  const buckets = { 0: 0, 1: 0, 2: 0, escalated: 0 };
  for (const o of orders) {
    if (o.status === "ESCALATED") {
      buckets.escalated += 1;
    } else if (o.revisionRound === 0) {
      buckets[0] += 1;
    } else if (o.revisionRound === 1) {
      buckets[1] += 1;
    } else {
      buckets[2] += 1;
    }
  }

  return [
    { label: "0 rounds (first-pass approval)", count: buckets[0] },
    { label: "1 round", count: buckets[1] },
    { label: "2 rounds", count: buckets[2] },
    { label: "Escalated (unresolved)", count: buckets.escalated },
  ];
}

export interface ExistingVsNewSplit {
  existingCount: number;
  newCount: number;
  unsetCount: number;
}

export async function getExistingVsNewSplit(user: AnalyticsUser, since: Date | null): Promise<ExistingVsNewSplit> {
  const orders = await db.artworkOrder.findMany({
    where: { ...artworkOrderAccessWhere(user), ...(since ? { createdAt: { gte: since } } : {}) },
    select: { existingGraphicsStatus: true },
  });
  return {
    existingCount: orders.filter((o) => o.existingGraphicsStatus === "EXISTING").length,
    newCount: orders.filter((o) => o.existingGraphicsStatus === "NEW_IMAGE").length,
    unsetCount: orders.filter((o) => o.existingGraphicsStatus === null).length,
  };
}

export interface ShowComparisonRow {
  showId: string | null;
  showName: string;
  totalPieces: number;
  existingCount: number;
  newCount: number;
}

// Not time-windowed like the metrics above -- comparing whole-show totals
// across occurrences (see the Show rollover feature) is the point, and
// each occurrence already spans its own different period. Derived from the
// already-fetched GraphicsOrder[] (same shape getGraphicsBreakdowns takes)
// rather than its own query -- one more reason both live off one shared
// `orders` fetch per page render.
export function getShowComparison(orders: GraphicsOrder[]): ShowComparisonRow[] {
  const byShow = new Map<string, ShowComparisonRow>();
  for (const o of orders) {
    const show = o.opportunity?.show ?? o.show;
    const key = show?.id ?? "__none__";
    let row = byShow.get(key);
    if (!row) {
      row = { showId: show?.id ?? null, showName: show?.name ?? "No show linked", totalPieces: 0, existingCount: 0, newCount: 0 };
      byShow.set(key, row);
    }
    row.totalPieces += 1;
    if (o.existingGraphicsStatus === "EXISTING") row.existingCount += 1;
    if (o.existingGraphicsStatus === "NEW_IMAGE") row.newCount += 1;
  }
  return [...byShow.values()].sort((a, b) => b.totalPieces - a.totalPieces);
}
