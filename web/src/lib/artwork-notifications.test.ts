import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  getEscalationNotifyEmails,
  getGraphicsDepartmentEmails,
  getSalesNotifyEmails,
  notifyClientInvited,
} from "@/lib/artwork-notifications";
import { createArtworkOrder } from "@/lib/artwork-order-service";

afterEach(async () => {
  await db.artworkOrderEvent.deleteMany();
  await db.artworkPortalInvite.deleteMany();
  await db.artworkOrder.deleteMany();
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

describe("notifyClientInvited", () => {
  it("returns the real client-portal link -- the only moment it's ever recoverable, since only its hash is persisted", async () => {
    const company = await db.company.create({ data: { name: "Test Co 5" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const order = await createArtworkOrder({ opportunityId: opportunity.id });

    const link = await notifyClientInvited(order.id, "client@example.com");

    expect(link).toContain(`/client-portal/`);
    const invite = await db.artworkPortalInvite.findFirstOrThrow({ where: { artworkOrderId: order.id } });
    expect(link).toContain(invite.id);
    // The raw token itself is never persisted (only tokenHash) -- can't
    // assert the link's token half against anything stored, only that a
    // real invite row backs the id half of the link that was returned.
  });
});

describe("getGraphicsDepartmentEmails", () => {
  it("returns every active GR-department user, not just one recipient", async () => {
    await db.user.create({ data: { name: "GR One", email: "gr1@example.com", departmentCode: "GR" } });
    await db.user.create({ data: { name: "GR Two", email: "gr2@example.com", departmentCode: "GR" } });
    await db.user.create({ data: { name: "Not GR", email: "sales@example.com", departmentCode: "SL" } });

    const emails = await getGraphicsDepartmentEmails();
    expect(new Set(emails)).toEqual(new Set(["gr1@example.com", "gr2@example.com"]));
  });

  it("returns an empty array when nobody is in the GR department", async () => {
    await db.user.create({ data: { name: "Not GR", email: "sales@example.com", departmentCode: "SL" } });
    expect(await getGraphicsDepartmentEmails()).toEqual([]);
  });
});

describe("getSalesNotifyEmails", () => {
  it("prefers the assigned sales rep over the owner", async () => {
    const owner = await makeUser("owner-sn@example.com");
    const salesRep = await makeUser("salesrep-sn@example.com");
    const company = await db.company.create({ data: { name: "Test Co SN" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", ownerId: owner.id, salesRepId: salesRep.id },
    });

    expect(await getSalesNotifyEmails(opportunity.id)).toEqual(["salesrep-sn@example.com"]);
  });

  it("falls back to the owner when no sales rep is assigned", async () => {
    const owner = await makeUser("owner-sn2@example.com");
    const company = await db.company.create({ data: { name: "Test Co SN2" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", ownerId: owner.id },
    });

    expect(await getSalesNotifyEmails(opportunity.id)).toEqual(["owner-sn2@example.com"]);
  });

  it("returns an empty array when neither a sales rep nor an owner is assigned", async () => {
    const company = await db.company.create({ data: { name: "Test Co SN3" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });

    expect(await getSalesNotifyEmails(opportunity.id)).toEqual([]);
  });
});
