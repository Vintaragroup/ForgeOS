import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getMyClientGraphicsSummary, rolloverShow } from "@/lib/artwork-hub";

const EXPO_ACTOR = { type: "EXPO" as const, userId: "user-1" };

afterEach(async () => {
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.show.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string) {
  return db.user.create({ data: { email, name: email, systemRole: "EMPLOYEE" } });
}

let jobCodeCounter = 0;
async function makeArtworkOrder(opportunityId: string, status: "INVITED" | "ORDER_DRAFTED" | "SUBMITTED" | "PACKAGED_READY") {
  jobCodeCounter += 1;
  return db.artworkOrder.create({
    data: { opportunityId, status, jobCode: `TEST-${jobCodeCounter}` },
  });
}

describe("getMyClientGraphicsSummary", () => {
  it("returns a client's graphics summary even on an opportunity the AE doesn't own or collaborate on", async () => {
    const ae = await makeUser("ae@test.com");
    const owner = await makeUser("owner@test.com");
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", ownerId: owner.id, salesRepId: ae.id, stage: "WON" },
    });
    await makeArtworkOrder(opportunity.id, "SUBMITTED");
    await makeArtworkOrder(opportunity.id, "PACKAGED_READY");

    const summary = await getMyClientGraphicsSummary({ id: ae.id });
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      opportunityId: opportunity.id,
      companyName: "Test Co",
      totalPieces: 2,
      artReceivedCount: 2,
    });
  });

  it("counts a piece still in the client's own hands as not yet art-received", async () => {
    const ae = await makeUser("ae2@test.com");
    const company = await db.company.create({ data: { name: "Test Co 2" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show 2", salesRepId: ae.id, stage: "WON" },
    });
    await makeArtworkOrder(opportunity.id, "INVITED");
    await makeArtworkOrder(opportunity.id, "ORDER_DRAFTED");
    await makeArtworkOrder(opportunity.id, "SUBMITTED");

    const summary = await getMyClientGraphicsSummary({ id: ae.id });
    expect(summary[0]).toMatchObject({ totalPieces: 3, artReceivedCount: 1 });
  });

  it("excludes an opportunity where the caller isn't the assigned sales rep", async () => {
    const ae = await makeUser("ae3@test.com");
    const someoneElse = await makeUser("someone3@test.com");
    const company = await db.company.create({ data: { name: "Test Co 3" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show 3", salesRepId: someoneElse.id, stage: "WON" },
    });
    await makeArtworkOrder(opportunity.id, "SUBMITTED");

    const summary = await getMyClientGraphicsSummary({ id: ae.id });
    expect(summary).toHaveLength(0);
  });

  it("excludes an opportunity with no artwork orders yet", async () => {
    const ae = await makeUser("ae4@test.com");
    const company = await db.company.create({ data: { name: "Test Co 4" } });
    await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show 4", salesRepId: ae.id, stage: "WON" },
    });

    const summary = await getMyClientGraphicsSummary({ id: ae.id });
    expect(summary).toHaveLength(0);
  });
});

describe("rolloverShow", () => {
  it("creates a new opportunity + rolled-over pieces per returning company", async () => {
    const sourceShow = await db.show.create({ data: { name: "PGA Show 2026" } });
    const targetShow = await db.show.create({ data: { name: "PGA Show 2027" } });
    const company1 = await db.company.create({ data: { name: "Titleist" } });
    const company2 = await db.company.create({ data: { name: "Callaway" } });

    const opp1 = await db.opportunity.create({
      data: { companyId: company1.id, showId: sourceShow.id, showName: "PGA Show 2026" },
    });
    const opp2 = await db.opportunity.create({
      data: { companyId: company2.id, showId: sourceShow.id, showName: "PGA Show 2026" },
    });
    await db.artworkOrder.create({ data: { opportunityId: opp1.id, jobCode: "EXPO-A1", graphicCode: "A1", qty: 1 } });
    await db.artworkOrder.create({ data: { opportunityId: opp1.id, jobCode: "EXPO-A2", graphicCode: "A2", qty: 1 } });
    await db.artworkOrder.create({ data: { opportunityId: opp2.id, jobCode: "EXPO-B1", graphicCode: "B1", qty: 1 } });

    const result = await rolloverShow({ sourceShowId: sourceShow.id, targetShowId: targetShow.id }, EXPO_ACTOR);
    expect(result).toEqual({ opportunitiesCreated: 2, piecesCreated: 3 });

    const targetOpportunities = await db.opportunity.findMany({
      where: { showId: targetShow.id },
      include: { artworkOrders: true },
    });
    expect(targetOpportunities).toHaveLength(2);
    const targetOpp1 = targetOpportunities.find((o) => o.companyId === company1.id);
    expect(targetOpp1?.artworkOrders).toHaveLength(2);
    expect(targetOpp1?.artworkOrders.every((a) => a.existingGraphicsStatus === "EXISTING")).toBe(true);
    const targetOpp2 = targetOpportunities.find((o) => o.companyId === company2.id);
    expect(targetOpp2?.artworkOrders).toHaveLength(1);
  });

  it("is idempotent -- running it twice doesn't duplicate opportunities or pieces", async () => {
    const sourceShow = await db.show.create({ data: { name: "PGA Show 2026" } });
    const targetShow = await db.show.create({ data: { name: "PGA Show 2027" } });
    const company = await db.company.create({ data: { name: "Titleist" } });
    const opp = await db.opportunity.create({
      data: { companyId: company.id, showId: sourceShow.id, showName: "PGA Show 2026" },
    });
    await db.artworkOrder.create({ data: { opportunityId: opp.id, jobCode: "EXPO-A1", graphicCode: "A1", qty: 1 } });

    await rolloverShow({ sourceShowId: sourceShow.id, targetShowId: targetShow.id }, EXPO_ACTOR);
    const second = await rolloverShow({ sourceShowId: sourceShow.id, targetShowId: targetShow.id }, EXPO_ACTOR);

    expect(second).toEqual({ opportunitiesCreated: 0, piecesCreated: 0 });
    const targetOpportunities = await db.opportunity.findMany({
      where: { showId: targetShow.id },
      include: { artworkOrders: true },
    });
    expect(targetOpportunities).toHaveLength(1);
    expect(targetOpportunities[0].artworkOrders).toHaveLength(1);
  });

  it("rolls a Hub/hanging-sign piece (no opportunity) directly under the target show", async () => {
    const sourceShow = await db.show.create({ data: { name: "PGA Show 2026" } });
    const targetShow = await db.show.create({ data: { name: "PGA Show 2027" } });
    await db.artworkOrder.create({ data: { showId: sourceShow.id, jobCode: "EXPO-HUB1", graphicCode: "HUB-01", qty: 1 } });

    const result = await rolloverShow({ sourceShowId: sourceShow.id, targetShowId: targetShow.id }, EXPO_ACTOR);
    expect(result).toEqual({ opportunitiesCreated: 0, piecesCreated: 1 });

    const targetPieces = await db.artworkOrder.findMany({ where: { showId: targetShow.id } });
    expect(targetPieces).toHaveLength(1);
    expect(targetPieces[0].opportunityId).toBeNull();
    expect(targetPieces[0].graphicCode).toBe("HUB-01");
  });

  it("adds only the missing pieces to a company already present on the target show", async () => {
    const sourceShow = await db.show.create({ data: { name: "PGA Show 2026" } });
    const targetShow = await db.show.create({ data: { name: "PGA Show 2027" } });
    const company = await db.company.create({ data: { name: "Titleist" } });
    const sourceOpp = await db.opportunity.create({
      data: { companyId: company.id, showId: sourceShow.id, showName: "PGA Show 2026" },
    });
    await db.artworkOrder.create({ data: { opportunityId: sourceOpp.id, jobCode: "EXPO-A1", graphicCode: "A1", qty: 1 } });
    await db.artworkOrder.create({ data: { opportunityId: sourceOpp.id, jobCode: "EXPO-A2", graphicCode: "A2", qty: 1 } });

    // Client was already hand-added to the target show before rollover ran.
    const existingTargetOpp = await db.opportunity.create({
      data: { companyId: company.id, showId: targetShow.id, showName: "PGA Show 2027" },
    });

    const result = await rolloverShow({ sourceShowId: sourceShow.id, targetShowId: targetShow.id }, EXPO_ACTOR);
    expect(result).toEqual({ opportunitiesCreated: 0, piecesCreated: 2 });

    const pieces = await db.artworkOrder.findMany({ where: { opportunityId: existingTargetOpp.id } });
    expect(pieces).toHaveLength(2);
  });
});
