import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { assignSingleVendor, describeRouting, loadArtworkRouting, setArtworkRouting, signShopOffices } from "@/lib/artwork-routing";
import { UserError } from "@/lib/user-error";

afterEach(async () => {
  await db.artworkOrderRouting.deleteMany();
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.vendor.deleteMany();
  await db.office.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

let n = 0;
async function fixture() {
  n += 1;
  // Miami has a sign shop; Orlando does not. That difference is the whole
  // point of the validation below.
  await db.office.createMany({
    data: [
      { code: "MIA", name: "Miami", hasSignShop: true, hasProductionArtists: true },
      { code: "ORL", name: "Orlando", hasSignShop: false, hasProductionArtists: false },
    ],
  });
  const binick = await db.vendor.create({ data: { name: "Binick Imaginig - Miami", initials: `BINICK${n}` } });
  const binca = await db.vendor.create({ data: { name: "Binca - Miami", initials: `BINCA${n}` } });
  const company = await db.company.create({ data: { name: "Routing Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Seatrade", stage: "WON" } });
  const order = await db.artworkOrder.create({ data: { opportunityId: opportunity.id, jobCode: `ROUTE-${n}` } });
  return { order, binick, binca };
}

describe("setArtworkRouting", () => {
  it("records a piece split between the sign shop and an outside vendor", async () => {
    const { order, binick } = await fixture();
    // 50 of 282 Seatrade rows look exactly like this.
    await setArtworkRouting(order.id, [
      { kind: "EXPO_IN_HOUSE", officeCode: "MIA" },
      { kind: "VENDOR", vendorId: binick.id },
    ]);

    const routings = await loadArtworkRouting(order.id);
    expect(routings).toHaveLength(2);
    expect(describeRouting(routings)).toBe("Expo (Miami) + Binick Imaginig - Miami");
  });

  it("refuses in-house production at an office with no sign shop", async () => {
    const { order } = await fixture();
    await expect(setArtworkRouting(order.id, [{ kind: "EXPO_IN_HOUSE", officeCode: "ORL" }])).rejects.toThrow(
      /Orlando has no sign shop/,
    );
    expect(await loadArtworkRouting(order.id)).toHaveLength(0);
  });

  it("allows AM/PM coordination anywhere, since no Expo shop is involved", async () => {
    const { order } = await fixture();
    const routings = await setArtworkRouting(order.id, [{ kind: "AM_PM_COORDINATED", note: "Julian's local shop" }]);
    expect(routings).toHaveLength(1);
    expect(describeRouting(routings)).toBe("AM/PM coordinating");
    expect(routings[0].note).toBe("Julian's local shop");
  });

  it("replaces the set rather than accumulating, so a half can be removed", async () => {
    const { order, binick } = await fixture();
    await setArtworkRouting(order.id, [
      { kind: "EXPO_IN_HOUSE", officeCode: "MIA" },
      { kind: "VENDOR", vendorId: binick.id },
    ]);
    await setArtworkRouting(order.id, [{ kind: "VENDOR", vendorId: binick.id }]);

    const routings = await loadArtworkRouting(order.id);
    expect(routings).toHaveLength(1);
    expect(routings[0].kind).toBe("VENDOR");
  });

  it("de-duplicates a repeated entry", async () => {
    const { order, binick } = await fixture();
    const routings = await setArtworkRouting(order.id, [
      { kind: "VENDOR", vendorId: binick.id },
      { kind: "VENDOR", vendorId: binick.id },
    ]);
    expect(routings).toHaveLength(1);
  });

  it("keeps two different shops apart", async () => {
    const { order, binick, binca } = await fixture();
    const routings = await setArtworkRouting(order.id, [
      { kind: "VENDOR", vendorId: binick.id },
      { kind: "VENDOR", vendorId: binca.id },
    ]);
    expect(routings).toHaveLength(2);
  });

  it("rejects a VENDOR entry with no shop, and one naming a deleted shop", async () => {
    const { order, binca } = await fixture();
    await expect(setArtworkRouting(order.id, [{ kind: "VENDOR" }])).rejects.toThrow(UserError);
    await db.vendor.update({ where: { id: binca.id }, data: { deletedAt: new Date() } });
    await expect(setArtworkRouting(order.id, [{ kind: "VENDOR", vendorId: binca.id }])).rejects.toThrow(/no longer exists/);
  });

  it("keeps the legacy vendorId column in step", async () => {
    const { order, binick } = await fixture();
    await setArtworkRouting(order.id, [
      { kind: "EXPO_IN_HOUSE", officeCode: "MIA" },
      { kind: "VENDOR", vendorId: binick.id },
    ]);
    expect((await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } })).vendorId).toBe(binick.id);

    // Routed entirely in-house: there is no vendor to point at.
    await setArtworkRouting(order.id, [{ kind: "EXPO_IN_HOUSE", officeCode: "MIA" }]);
    expect((await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } })).vendorId).toBeNull();
  });

  it("reports an unrouted piece honestly", async () => {
    const { order } = await fixture();
    expect(describeRouting(await loadArtworkRouting(order.id))).toBe("Not routed yet");
  });
});

describe("signShopOffices", () => {
  it("offers only offices that can actually produce, so the UI can't suggest a rejection", async () => {
    await fixture();
    expect((await signShopOffices()).map((o) => o.code)).toEqual(["MIA"]);
  });
});

describe("assignSingleVendor", () => {
  it("replaces the outside shop but keeps the in-house half", async () => {
    const { order, binick, binca } = await fixture();
    await setArtworkRouting(order.id, [
      { kind: "EXPO_IN_HOUSE", officeCode: "MIA" },
      { kind: "VENDOR", vendorId: binick.id },
    ]);

    await assignSingleVendor(order.id, binca.id);

    const routings = await loadArtworkRouting(order.id);
    // The in-house half survives -- assigning a vendor must not silently
    // delete the fact that Miami is printing part of the same piece.
    expect(routings.map((r) => r.kind).sort()).toEqual(["EXPO_IN_HOUSE", "VENDOR"]);
    expect(routings.find((r) => r.kind === "VENDOR")?.vendorId).toBe(binca.id);
  });

  it("works on a piece with no routing yet", async () => {
    const { order, binick } = await fixture();
    const routings = await assignSingleVendor(order.id, binick.id);
    expect(routings).toHaveLength(1);
    expect(routings[0].vendorId).toBe(binick.id);
  });
});
