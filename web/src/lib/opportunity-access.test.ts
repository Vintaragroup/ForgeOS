import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { canAccessOpportunity, opportunityAccessWhere } from "@/lib/opportunity-access";

afterEach(async () => {
  await db.opportunityCollaborator.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(systemRole: "EMPLOYEE" | "ADMIN" | "SUPER_ADMIN" = "EMPLOYEE") {
  return db.user.create({
    data: { name: "Test User", email: `${Math.random()}@test.com`, systemRole },
  });
}

async function makeOpportunity(companyId: string, ownerId?: string) {
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId } });
  return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show", ownerId } });
}

describe("canAccessOpportunity", () => {
  it("grants an ADMIN access regardless of ownership or collaboration", async () => {
    const admin = await makeUser("ADMIN");
    const owner = await makeUser();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await makeOpportunity(company.id, owner.id);

    expect(await canAccessOpportunity(admin, opportunity.id)).toBe(true);
  });

  it("grants a SUPER_ADMIN access regardless of ownership or collaboration", async () => {
    const superAdmin = await makeUser("SUPER_ADMIN");
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await makeOpportunity(company.id);

    expect(await canAccessOpportunity(superAdmin, opportunity.id)).toBe(true);
  });

  it("grants the owner access", async () => {
    const owner = await makeUser();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await makeOpportunity(company.id, owner.id);

    expect(await canAccessOpportunity(owner, opportunity.id)).toBe(true);
  });

  it("grants an explicit collaborator access", async () => {
    const owner = await makeUser();
    const collaborator = await makeUser();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await makeOpportunity(company.id, owner.id);
    await db.opportunityCollaborator.create({ data: { opportunityId: opportunity.id, userId: collaborator.id } });

    expect(await canAccessOpportunity(collaborator, opportunity.id)).toBe(true);
  });

  it("denies a regular employee who is neither owner nor collaborator", async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await makeOpportunity(company.id, owner.id);

    expect(await canAccessOpportunity(stranger, opportunity.id)).toBe(false);
  });

  it("denies access to an opportunity that doesn't exist", async () => {
    const user = await makeUser();
    expect(await canAccessOpportunity(user, "nonexistent-id")).toBe(false);
  });

  it("denies access to an unowned opportunity for a non-collaborator employee", async () => {
    const stranger = await makeUser();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await makeOpportunity(company.id); // no owner

    expect(await canAccessOpportunity(stranger, opportunity.id)).toBe(false);
  });
});

describe("opportunityAccessWhere", () => {
  it("returns an unrestricted filter for admins", async () => {
    const admin = await makeUser("ADMIN");
    expect(opportunityAccessWhere(admin)).toEqual({});
  });

  it("returns an owner-or-collaborator filter for a regular employee, and that filter actually restricts a real query", async () => {
    const owner = await makeUser();
    const collaborator = await makeUser();
    const stranger = await makeUser();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const ownedOpp = await makeOpportunity(company.id, owner.id);
    const collabOpp = await makeOpportunity(company.id, stranger.id);
    await db.opportunityCollaborator.create({ data: { opportunityId: collabOpp.id, userId: collaborator.id } });
    await makeOpportunity(company.id, stranger.id); // an opportunity neither owner nor collaborator can see

    const results = await db.opportunity.findMany({
      where: { OR: [{ id: ownedOpp.id }, { id: collabOpp.id }], ...opportunityAccessWhere(owner) },
    });
    expect(results.map((o) => o.id)).toEqual([ownedOpp.id]);

    const collabResults = await db.opportunity.findMany({
      where: { OR: [{ id: ownedOpp.id }, { id: collabOpp.id }], ...opportunityAccessWhere(collaborator) },
    });
    expect(collabResults.map((o) => o.id)).toEqual([collabOpp.id]);
  });
});
