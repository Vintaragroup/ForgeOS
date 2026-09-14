import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { GraphicsOrder } from "@/lib/artwork-hub";
import {
  getVendorTurnaround,
  getRevisionRoundsDistribution,
  getExistingVsNewSplit,
  getShowComparison,
} from "@/lib/graphics-analytics";

const grUser = { id: "gr-user", systemRole: "EMPLOYEE" as const, departmentCode: "GR" };

afterEach(async () => {
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.show.deleteMany();
  await db.vendor.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

let jobCodeCounter = 0;
async function makeOrder(overrides: {
  vendorId?: string | null;
  revisionRound?: number;
  status?: "INVITED" | "ESCALATED";
  existingGraphicsStatus?: "EXISTING" | "NEW_IMAGE" | null;
  createdAt?: Date;
}) {
  const company = await db.company.create({ data: { name: `Co ${Math.random()}` } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  jobCodeCounter += 1;
  return db.artworkOrder.create({
    data: {
      opportunityId: opportunity.id,
      jobCode: `TEST-${jobCodeCounter}`,
      vendorId: overrides.vendorId ?? null,
      revisionRound: overrides.revisionRound ?? 0,
      status: overrides.status ?? "INVITED",
      existingGraphicsStatus: overrides.existingGraphicsStatus ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
}

async function addEvent(artworkOrderId: string, toStatus: "PRODUCTION_GO_AHEAD" | "PACKAGED_READY", createdAt: Date) {
  await db.artworkOrderEvent.create({
    data: { artworkOrderId, toStatus, action: "TEST", actorType: "EXPO", createdAt },
  });
}

describe("getVendorTurnaround", () => {
  it("computes avg days from production-go-ahead to packaged-ready per vendor", async () => {
    const vendor = await db.vendor.create({ data: { name: "Test Vendor" } });
    const order = await makeOrder({ vendorId: vendor.id });
    const goAheadAt = new Date("2026-01-01T00:00:00Z");
    const packagedAt = new Date("2026-01-05T00:00:00Z");
    await addEvent(order.id, "PRODUCTION_GO_AHEAD", goAheadAt);
    await addEvent(order.id, "PACKAGED_READY", packagedAt);

    const rows = await getVendorTurnaround(grUser, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ vendorName: "Test Vendor", avgDays: 4, sampleSize: 1 });
  });

  it("excludes an order missing either event", async () => {
    const vendor = await db.vendor.create({ data: { name: "Incomplete Vendor" } });
    const order = await makeOrder({ vendorId: vendor.id });
    await addEvent(order.id, "PRODUCTION_GO_AHEAD", new Date());

    const rows = await getVendorTurnaround(grUser, null);
    expect(rows).toHaveLength(0);
  });

  it("excludes events outside the requested window", async () => {
    const vendor = await db.vendor.create({ data: { name: "Old Vendor" } });
    const order = await makeOrder({ vendorId: vendor.id });
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await addEvent(order.id, "PRODUCTION_GO_AHEAD", longAgo);
    await addEvent(order.id, "PACKAGED_READY", new Date(longAgo.getTime() + 24 * 60 * 60 * 1000));

    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const rows = await getVendorTurnaround(grUser, since);
    expect(rows).toHaveLength(0);
  });

  it("averages across multiple orders for the same vendor and sorts fastest first", async () => {
    const fast = await db.vendor.create({ data: { name: "Fast Vendor" } });
    const slow = await db.vendor.create({ data: { name: "Slow Vendor" } });

    const o1 = await makeOrder({ vendorId: fast.id });
    await addEvent(o1.id, "PRODUCTION_GO_AHEAD", new Date("2026-01-01T00:00:00Z"));
    await addEvent(o1.id, "PACKAGED_READY", new Date("2026-01-02T00:00:00Z"));

    const o2 = await makeOrder({ vendorId: slow.id });
    await addEvent(o2.id, "PRODUCTION_GO_AHEAD", new Date("2026-01-01T00:00:00Z"));
    await addEvent(o2.id, "PACKAGED_READY", new Date("2026-01-10T00:00:00Z"));

    const rows = await getVendorTurnaround(grUser, null);
    expect(rows.map((r) => r.vendorName)).toEqual(["Fast Vendor", "Slow Vendor"]);
  });
});

describe("getRevisionRoundsDistribution", () => {
  it("buckets orders by revisionRound, with ESCALATED status as its own bucket regardless of revisionRound", async () => {
    await makeOrder({ revisionRound: 0 });
    await makeOrder({ revisionRound: 1 });
    await makeOrder({ revisionRound: 2 });
    await makeOrder({ revisionRound: 2, status: "ESCALATED" });

    const buckets = await getRevisionRoundsDistribution(grUser, null);
    expect(buckets).toEqual([
      { label: "0 rounds (first-pass approval)", count: 1 },
      { label: "1 round", count: 1 },
      { label: "2 rounds", count: 1 },
      { label: "Escalated (unresolved)", count: 1 },
    ]);
  });

  it("respects the since window via createdAt", async () => {
    const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    await makeOrder({ revisionRound: 0, createdAt: longAgo });
    await makeOrder({ revisionRound: 1 });

    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const buckets = await getRevisionRoundsDistribution(grUser, since);
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    expect(total).toBe(1);
  });
});

describe("getExistingVsNewSplit", () => {
  it("counts EXISTING, NEW_IMAGE, and unset separately", async () => {
    await makeOrder({ existingGraphicsStatus: "EXISTING" });
    await makeOrder({ existingGraphicsStatus: "EXISTING" });
    await makeOrder({ existingGraphicsStatus: "NEW_IMAGE" });
    await makeOrder({ existingGraphicsStatus: null });

    const split = await getExistingVsNewSplit(grUser, null);
    expect(split).toEqual({ existingCount: 2, newCount: 1, unsetCount: 1 });
  });
});

describe("getShowComparison", () => {
  function fakeOrder(overrides: {
    opportunityShow?: { id: string; name: string } | null;
    directShow?: { id: string; name: string } | null;
    existingGraphicsStatus?: "EXISTING" | "NEW_IMAGE" | null;
  }): GraphicsOrder {
    return {
      opportunity: overrides.opportunityShow !== undefined ? { show: overrides.opportunityShow } : null,
      show: overrides.directShow ?? null,
      existingGraphicsStatus: overrides.existingGraphicsStatus ?? null,
    } as unknown as GraphicsOrder;
  }

  it("groups by the opportunity's show, falling back to the order's own direct show", () => {
    const show = { id: "show-1", name: "PGA Show 2026" };
    const orders = [
      fakeOrder({ opportunityShow: show, existingGraphicsStatus: "EXISTING" }),
      fakeOrder({ opportunityShow: null, directShow: show, existingGraphicsStatus: "NEW_IMAGE" }),
    ];

    const rows = getShowComparison(orders);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ showId: "show-1", showName: "PGA Show 2026", totalPieces: 2, existingCount: 1, newCount: 1 });
  });

  it("groups pieces with no show linked at all under one 'No show linked' row", () => {
    const orders = [fakeOrder({ opportunityShow: null, directShow: null }), fakeOrder({ opportunityShow: null, directShow: null })];

    const rows = getShowComparison(orders);
    expect(rows).toEqual([{ showId: null, showName: "No show linked", totalPieces: 2, existingCount: 0, newCount: 0 }]);
  });

  it("sorts shows by total pieces, most first", () => {
    const small = { id: "show-a", name: "Small Show" };
    const big = { id: "show-b", name: "Big Show" };
    const orders = [
      fakeOrder({ opportunityShow: small }),
      fakeOrder({ opportunityShow: big }),
      fakeOrder({ opportunityShow: big }),
    ];

    const rows = getShowComparison(orders);
    expect(rows.map((r) => r.showName)).toEqual(["Big Show", "Small Show"]);
  });
});
