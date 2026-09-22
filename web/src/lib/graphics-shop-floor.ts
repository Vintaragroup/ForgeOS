// The Graphics queues answer "where is this piece in the pipeline". The
// shop floor answers a different question: "what does each shop owe us."
//
// The unit here is the HALF, not the piece. Gabriella's Shop column is
// multi-select and 50 of the 282 rows in the Seatrade export carry two
// values -- one graphic split between Expo's own sign shop and an outside
// vendor, each half finishing separately. A split piece is genuinely two
// pieces of work at two shops, so it appears under both, and a view keyed
// on the order would have to pick one and lie about the other.
//
// A leaf module: pure functions over plain data, no db import.

import type { ArtworkOrderStatus, ArtworkProductionStatus, ArtworkRoutingKind } from "@/generated/prisma/enums";
import { isHalfSettled, PRODUCTION_STATUS_LABELS } from "@/lib/artwork-routing-vocab";

// Once a piece is delivered or cancelled the shop owes nothing more on it,
// whatever its halves still say.
const OFF_THE_FLOOR: ReadonlySet<ArtworkOrderStatus> = new Set(["DELIVERED_AT_SHOW", "CANCELLED"]);

// Before the art is accepted there is nothing to route yet, so an
// unrouted piece is not a gap -- it is just early. From ACCEPTED onward a
// piece with no routing has nowhere to be made, which is a real problem
// and easy to miss.
const SHOULD_BE_ROUTED: ReadonlySet<ArtworkOrderStatus> = new Set([
  "ACCEPTED",
  "VENDOR_ASSIGNED",
  "PROOF_IN_PROGRESS",
  "PROOF_SUBMITTED",
  "EXPO_PROOF_CHECK",
  "PROOF_REVISION_REQUESTED",
  "ESCALATED",
  "PROOF_UNDER_REVIEW",
  "PROOF_APPROVED",
  "PRODUCTION_GO_AHEAD",
  "IN_PRODUCTION",
  "RECEIVED_FROM_VENDOR",
  "INSPECTED",
  "REPRINT_REQUESTED",
  "PACKAGED_READY",
  "SHIPPED_TO_SHOW",
]);

export interface ShopFloorRouting {
  id: string;
  kind: ArtworkRoutingKind;
  productionStatus: ArtworkProductionStatus;
  vendor: { id: string; name: string } | null;
  office: { code: string; name: string } | null;
}

export interface ShopFloorFacts {
  status: ArtworkOrderStatus;
  inHandDate: Date | null;
  routings: ShopFloorRouting[];
}

export interface ShopHalf<T> {
  order: T;
  routingId: string;
  kind: ArtworkRoutingKind;
  productionStatus: ArtworkProductionStatus;
  statusLabel: string;
  inHandDate: Date | null;
  // In-hand date already passed and this half hasn't settled.
  late: boolean;
}

export interface ShopGroup<T> {
  key: string;
  label: string;
  kind: ArtworkRoutingKind;
  // Halves this shop still owes, soonest in-hand date first.
  open: ShopHalf<T>[];
  // How many of this shop's halves have already settled. A count, not a
  // list -- finished work is context, not a queue.
  settledCount: number;
  lateCount: number;
  // Open halves broken down by where they actually are, in the order the
  // kind's own status list defines, so a shop's row reads as a pipeline
  // rather than an unordered tally.
  byStatus: { status: ArtworkProductionStatus; label: string; count: number }[];
}

export interface ShopFloor<T> {
  shops: ShopGroup<T>[];
  // Past ACCEPTED with no routing at all: nowhere to be made.
  unrouted: T[];
  openHalfCount: number;
  lateHalfCount: number;
}

// One stable identity per real shop, so the same vendor reached from two
// different pieces groups together. Mirrors routingKey in artwork-routing,
// which de-duplicates a single piece's own set by the same rule.
function shopKey(routing: ShopFloorRouting): string {
  switch (routing.kind) {
    case "VENDOR":
      return `vendor:${routing.vendor?.id ?? "unknown"}`;
    case "EXPO_IN_HOUSE":
      return `office:${routing.office?.code ?? "unknown"}`;
    default:
      return "ampm";
  }
}

function shopLabel(routing: ShopFloorRouting): string {
  switch (routing.kind) {
    case "VENDOR":
      return routing.vendor?.name ?? "Unknown shop";
    case "EXPO_IN_HOUSE":
      return routing.office ? `Expo — ${routing.office.name}` : "Expo sign shop";
    default:
      return "AM/PM coordinating";
  }
}

function byDateAscNullsLast(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

export function buildShopFloor<T>(
  orders: T[],
  read: (order: T) => ShopFloorFacts,
  now: Date = new Date(),
): ShopFloor<T> {
  const groups = new Map<string, ShopGroup<T>>();
  const unrouted: T[] = [];

  for (const order of orders) {
    const facts = read(order);
    if (OFF_THE_FLOOR.has(facts.status)) continue;

    if (facts.routings.length === 0) {
      if (SHOULD_BE_ROUTED.has(facts.status)) unrouted.push(order);
      continue;
    }

    for (const routing of facts.routings) {
      const key = shopKey(routing);
      let group = groups.get(key);
      if (!group) {
        group = { key, label: shopLabel(routing), kind: routing.kind, open: [], settledCount: 0, lateCount: 0, byStatus: [] };
        groups.set(key, group);
      }

      if (isHalfSettled(routing.productionStatus)) {
        group.settledCount += 1;
        continue;
      }

      // Deliberately compares against the piece's in-hand date, not the
      // half's own: a half has no date of its own, and the piece is late
      // if any half of it is.
      const late = facts.inHandDate != null && facts.inHandDate < now;
      if (late) group.lateCount += 1;
      group.open.push({
        order,
        routingId: routing.id,
        kind: routing.kind,
        productionStatus: routing.productionStatus,
        statusLabel: PRODUCTION_STATUS_LABELS[routing.productionStatus],
        inHandDate: facts.inHandDate,
        late,
      });
    }
  }

  const shops = [...groups.values()];
  for (const shop of shops) {
    shop.open.sort((a, b) => byDateAscNullsLast(a.inHandDate, b.inHandDate));
    const counts = new Map<ArtworkProductionStatus, number>();
    for (const half of shop.open) {
      counts.set(half.productionStatus, (counts.get(half.productionStatus) ?? 0) + 1);
    }
    shop.byStatus = [...counts.entries()]
      .map(([status, count]) => ({ status, label: PRODUCTION_STATUS_LABELS[status], count }))
      .sort((a, b) => b.count - a.count);
  }
  // Busiest shop first, and a shop with nothing open sinks below one that
  // still owes a single piece however much history it has.
  shops.sort((a, b) => b.open.length - a.open.length || a.label.localeCompare(b.label));

  return {
    shops,
    unrouted,
    openHalfCount: shops.reduce((n, s) => n + s.open.length, 0),
    lateHalfCount: shops.reduce((n, s) => n + s.lateCount, 0),
  };
}
