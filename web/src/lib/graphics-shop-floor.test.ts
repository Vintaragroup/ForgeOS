import { describe, expect, it } from "vitest";
import { buildShopFloor, type ShopFloorFacts, type ShopFloorRouting } from "@/lib/graphics-shop-floor";

const NOW = new Date("2026-09-23T12:00:00.000Z");

function days(n: number): Date {
  return new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);
}

let seq = 0;
function vendorHalf(name: string, status: ShopFloorRouting["productionStatus"] = "OS_SENT"): ShopFloorRouting {
  return { id: `r${++seq}`, kind: "VENDOR", productionStatus: status, vendor: { id: `v-${name}`, name }, office: null };
}
function expoHalf(status: ShopFloorRouting["productionStatus"] = "PRINTING"): ShopFloorRouting {
  return {
    id: `r${++seq}`,
    kind: "EXPO_IN_HOUSE",
    productionStatus: status,
    vendor: null,
    office: { code: "MIA", name: "Miami" },
  };
}
function ampmHalf(status: ShopFloorRouting["productionStatus"] = "NOT_STARTED"): ShopFloorRouting {
  return { id: `r${++seq}`, kind: "AM_PM_COORDINATED", productionStatus: status, vendor: null, office: null };
}

interface Piece extends ShopFloorFacts {
  id: string;
}

function piece(id: string, overrides: Partial<ShopFloorFacts> = {}): Piece {
  return { id, status: "IN_PRODUCTION", inHandDate: null, routings: [], ...overrides };
}

function floor(pieces: Piece[]) {
  return buildShopFloor(pieces, (p) => p, NOW);
}

describe("buildShopFloor", () => {
  it("puts a split piece under both shops -- it is two pieces of work", () => {
    // 50 of 282 Seatrade rows are split this way. A view keyed on the
    // order would have to pick one shop and lie about the other.
    const result = floor([piece("split", { routings: [expoHalf(), vendorHalf("Binick")] })]);
    expect(result.shops.map((s) => s.label).sort()).toEqual(["Binick", "Expo — Miami"]);
    expect(result.openHalfCount).toBe(2);
  });

  it("groups the same vendor reached from different pieces together", () => {
    const result = floor([
      piece("a", { routings: [vendorHalf("Binick")] }),
      piece("b", { routings: [vendorHalf("Binick")] }),
      piece("c", { routings: [vendorHalf("A3Visual")] }),
    ]);
    const binick = result.shops.find((s) => s.label === "Binick");
    expect(binick?.open).toHaveLength(2);
    expect(result.shops).toHaveLength(2);
  });

  it("counts a settled half instead of queueing it", () => {
    const result = floor([
      piece("done", { routings: [vendorHalf("Binick", "OS_RECEIVED")] }),
      piece("open", { routings: [vendorHalf("Binick", "OS_SENT")] }),
    ]);
    const binick = result.shops[0];
    expect(binick.settledCount).toBe(1);
    expect(binick.open.map((h) => h.order.id)).toEqual(["open"]);
  });

  it("treats a partially received half as still owed", () => {
    // "O.S Received Partially" is precisely the state that looks finished
    // on a dashboard and is not -- see isHalfSettled's own comment.
    const result = floor([piece("partial", { routings: [vendorHalf("Binick", "OS_RECEIVED_PARTIALLY")] })]);
    expect(result.shops[0].open).toHaveLength(1);
    expect(result.shops[0].settledCount).toBe(0);
  });

  it("drops a piece that is delivered or cancelled, whatever its halves say", () => {
    const result = floor([
      piece("delivered", { status: "DELIVERED_AT_SHOW", routings: [vendorHalf("Binick", "OS_SENT")] }),
      piece("cancelled", { status: "CANCELLED", routings: [vendorHalf("Binick", "OS_SENT")] }),
    ]);
    expect(result.shops).toHaveLength(0);
    expect(result.openHalfCount).toBe(0);
  });

  it("flags a piece with nowhere to be made, once it is past art acceptance", () => {
    const result = floor([piece("nowhere", { status: "PROOF_APPROVED", routings: [] })]);
    expect(result.unrouted.map((p) => p.id)).toEqual(["nowhere"]);
  });

  it("does not call an early piece unrouted -- there is nothing to route yet", () => {
    const result = floor([
      piece("invited", { status: "INVITED", routings: [] }),
      piece("drafted", { status: "ORDER_DRAFTED", routings: [] }),
      piece("review", { status: "UNDER_ART_REVIEW", routings: [] }),
    ]);
    expect(result.unrouted).toHaveLength(0);
  });

  it("marks a half late from the piece's in-hand date", () => {
    const result = floor([
      piece("late", { inHandDate: days(-4), routings: [vendorHalf("Binick")] }),
      piece("fine", { inHandDate: days(30), routings: [vendorHalf("Binick")] }),
    ]);
    const binick = result.shops[0];
    expect(binick.lateCount).toBe(1);
    expect(binick.open.find((h) => h.order.id === "late")?.late).toBe(true);
    expect(result.lateHalfCount).toBe(1);
  });

  it("puts the soonest in-hand date first within a shop, undated last", () => {
    const result = floor([
      piece("undated", { routings: [vendorHalf("Binick")] }),
      piece("far", { inHandDate: days(60), routings: [vendorHalf("Binick")] }),
      piece("near", { inHandDate: days(2), routings: [vendorHalf("Binick")] }),
    ]);
    expect(result.shops[0].open.map((h) => h.order.id)).toEqual(["near", "far", "undated"]);
  });

  it("puts the busiest shop first", () => {
    const result = floor([
      piece("a", { routings: [vendorHalf("Quiet")] }),
      piece("b", { routings: [vendorHalf("Busy")] }),
      piece("c", { routings: [vendorHalf("Busy")] }),
    ]);
    expect(result.shops.map((s) => s.label)).toEqual(["Busy", "Quiet"]);
  });

  it("breaks a shop's open work down by where it actually is", () => {
    const result = floor([
      piece("a", { routings: [vendorHalf("Binick", "OS_SENT")] }),
      piece("b", { routings: [vendorHalf("Binick", "OS_SENT")] }),
      piece("c", { routings: [vendorHalf("Binick", "OS_NOT_SENT")] }),
    ]);
    expect(result.shops[0].byStatus).toEqual([
      { status: "OS_SENT", label: "O.S sent", count: 2 },
      { status: "OS_NOT_SENT", label: "O.S not sent", count: 1 },
    ]);
  });

  it("keeps in-house, outsourced and AM/PM work apart", () => {
    const result = floor([piece("a", { routings: [expoHalf(), vendorHalf("Binick"), ampmHalf()] })]);
    expect(result.shops.map((s) => s.kind).sort()).toEqual(["AM_PM_COORDINATED", "EXPO_IN_HOUSE", "VENDOR"]);
  });
});
