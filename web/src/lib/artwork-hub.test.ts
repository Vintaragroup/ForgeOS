import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getMyClientGraphicsSummary } from "@/lib/artwork-hub";

afterEach(async () => {
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
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
