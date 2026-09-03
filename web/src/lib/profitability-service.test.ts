import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLineItem, addSection, createEstimateVersion } from "@/lib/estimate-service";
import {
  addInternalCost,
  computeTrueProfitability,
  deleteInternalCost,
  updateInternalCost,
  updateOpportunityProfitability,
} from "@/lib/profitability-service";

afterEach(async () => {
  await db.internalCost.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeEstimate() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return db.estimate.create({ data: { opportunityId: opportunity.id } });
}

describe("computeTrueProfitability", () => {
  const version = { totalCost: 100, grandTotal: 200 };

  it("nets profit down to grandTotal - totalCost when there are no internal costs", () => {
    const result = computeTrueProfitability(version, [], { anticipatedFeePct: null, contractedFeePct: null });
    expect(result.totalInternalCosts.toNumber()).toBe(0);
    expect(result.netProfit.toNumber()).toBe(100);
    expect(result.netMarginPct.toNumber()).toBe(50);
  });

  it("sums several internal costs and subtracts them from net profit", () => {
    const result = computeTrueProfitability(
      version,
      [{ amount: 20 }, { amount: 5 }],
      { anticipatedFeePct: null, contractedFeePct: null },
    );
    expect(result.totalInternalCosts.toNumber()).toBe(25);
    expect(result.netProfit.toNumber()).toBe(75); // 200 - 100 - 25
    expect(result.netMarginPct.toNumber()).toBe(37.5); // 75 / 200 * 100
  });

  it("returns null commission when a fee isn't set, and a real dollar figure when it is", () => {
    const noFee = computeTrueProfitability(version, [], { anticipatedFeePct: null, contractedFeePct: null });
    expect(noFee.anticipatedCommission).toBeNull();
    expect(noFee.contractedCommission).toBeNull();

    const withFee = computeTrueProfitability(version, [], { anticipatedFeePct: 10, contractedFeePct: 15 });
    // netProfit is 100 (200 - 100 - 0 internal costs)
    expect(withFee.anticipatedCommission?.toNumber()).toBe(10); // 100 * 10%
    expect(withFee.contractedCommission?.toNumber()).toBe(15); // 100 * 15%
  });

  it("commission is based on TRUE net profit, not gross sell price -- internal costs reduce it too", () => {
    const result = computeTrueProfitability(
      version,
      [{ amount: 50 }],
      { anticipatedFeePct: 10, contractedFeePct: null },
    );
    // netProfit is 50 (200 - 100 - 50), not 100
    expect(result.anticipatedCommission?.toNumber()).toBe(5); // 50 * 10%, not 10
  });

  it("defaults netMarginPct to 0 when grandTotal is zero, same convention as computeVersionTotals's grossMarginPct", () => {
    const result = computeTrueProfitability(
      { totalCost: 0, grandTotal: 0 },
      [],
      { anticipatedFeePct: null, contractedFeePct: null },
    );
    expect(result.netMarginPct.toNumber()).toBe(0);
  });
});

describe("InternalCost CRUD", () => {
  it("addInternalCost creates a cost, optionally tied to a section", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Custom Build", sectionType: "COMPONENT", groupLabel: "FS - Hitting Bay Wall" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", qty: 1, unitCost: 100 });

    const cost = await addInternalCost(version.id, {
      sectionId: section.id,
      category: "PROJECT_RELATED",
      description: "Extra crating for the hitting bay wall",
      amount: 250,
    });

    expect(cost.sectionId).toBe(section.id);
    expect(cost.category).toBe("PROJECT_RELATED");
    expect(cost.amount.toNumber()).toBe(250);
  });

  it("addInternalCost with no sectionId is a general, project-wide cost", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);

    const cost = await addInternalCost(version.id, {
      sectionId: null,
      category: "OVERHEAD",
      description: "PM overhead allocation",
      amount: 500,
    });

    expect(cost.sectionId).toBeNull();
  });

  it("updateInternalCost changes category/description/amount", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const cost = await addInternalCost(version.id, {
      sectionId: null,
      category: "OTHER",
      description: "Draft",
      amount: 100,
    });

    const updated = await updateInternalCost(cost.id, {
      category: "OVERHEAD",
      description: "Final",
      amount: 150,
    });

    expect(updated.category).toBe("OVERHEAD");
    expect(updated.description).toBe("Final");
    expect(updated.amount.toNumber()).toBe(150);
  });

  it("deleteInternalCost removes the row", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const cost = await addInternalCost(version.id, {
      sectionId: null,
      category: "OTHER",
      description: "To delete",
      amount: 100,
    });

    await deleteInternalCost(cost.id);

    await expect(db.internalCost.findUniqueOrThrow({ where: { id: cost.id } })).rejects.toThrow();
  });

  it("never touches the version's own totalCost/grandTotal -- entirely separate from sell-side totals", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 30);
    const section = await addSection(version.id, { name: "Custom Build", sectionType: "COMPONENT" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", qty: 1, unitCost: 1000 });

    const before = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    await addInternalCost(version.id, { sectionId: null, category: "OVERHEAD", description: "Big cost", amount: 99999 });
    const after = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });

    expect(after.totalCost.toString()).toBe(before.totalCost.toString());
    expect(after.grandTotal.toString()).toBe(before.grandTotal.toString());
  });
});

describe("updateOpportunityProfitability", () => {
  it("sets salesRepId and both fee percentages", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const rep = await db.user.create({ data: { email: "rep@test.com", name: "Sales Rep" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });

    await updateOpportunityProfitability(opportunity.id, {
      salesRepId: rep.id,
      anticipatedFeePct: 10,
      contractedFeePct: null,
    });

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.salesRepId).toBe(rep.id);
    expect(updated.anticipatedFeePct?.toNumber()).toBe(10);
    expect(updated.contractedFeePct).toBeNull();
  });

  it("is a distinct field from ownerId -- assigning a sales rep never changes the opportunity owner", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const owner = await db.user.create({ data: { email: "owner@test.com", name: "Owner" } });
    const rep = await db.user.create({ data: { email: "rep2@test.com", name: "Sales Rep" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", ownerId: owner.id },
    });

    await updateOpportunityProfitability(opportunity.id, {
      salesRepId: rep.id,
      anticipatedFeePct: null,
      contractedFeePct: null,
    });

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.ownerId).toBe(owner.id);
    expect(updated.salesRepId).toBe(rep.id);
  });
});
