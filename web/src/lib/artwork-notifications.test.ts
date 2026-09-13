import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getEscalationNotifyEmails } from "@/lib/artwork-notifications";

afterEach(async () => {
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.show.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string) {
  return db.user.create({ data: { name: email, email } });
}

describe("getEscalationNotifyEmails", () => {
  it("notifies only the show's escalation contact when one is set, not the opportunity's own owner/salesRep", async () => {
    const owner = await makeUser("owner@example.com");
    const salesRep = await makeUser("salesrep@example.com");
    const coordinator = await makeUser("coordinator@example.com");
    const show = await db.show.create({ data: { name: "Test Show", escalationContactId: coordinator.id } });
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", showId: show.id, ownerId: owner.id, salesRepId: salesRep.id },
    });

    const emails = await getEscalationNotifyEmails(opportunity.id);
    expect(emails).toEqual(["coordinator@example.com"]);
  });

  it("falls back to owner + salesRep when the opportunity has no Show at all", async () => {
    const owner = await makeUser("owner2@example.com");
    const salesRep = await makeUser("salesrep2@example.com");
    const company = await db.company.create({ data: { name: "Test Co 2" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Standalone Job", ownerId: owner.id, salesRepId: salesRep.id },
    });

    const emails = await getEscalationNotifyEmails(opportunity.id);
    expect(new Set(emails)).toEqual(new Set(["owner2@example.com", "salesrep2@example.com"]));
  });

  it("falls back to owner + salesRep when the Show exists but has no escalation contact set", async () => {
    const owner = await makeUser("owner3@example.com");
    const show = await db.show.create({ data: { name: "Uncoordinated Show" } });
    const company = await db.company.create({ data: { name: "Test Co 3" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", showId: show.id, ownerId: owner.id },
    });

    const emails = await getEscalationNotifyEmails(opportunity.id);
    expect(emails).toEqual(["owner3@example.com"]);
  });

  it("returns an empty array when there is nobody to notify at all", async () => {
    const company = await db.company.create({ data: { name: "Test Co 4" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Orphan Job" } });

    const emails = await getEscalationNotifyEmails(opportunity.id);
    expect(emails).toEqual([]);
  });
});
