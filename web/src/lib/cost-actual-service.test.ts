import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLineItem, addSection, createEstimateVersion } from "@/lib/estimate-service";
import {
  computeActualTotal,
  computeDepartmentVariance,
  computeLineItemVariance,
  recordCostActual,
} from "@/lib/cost-actual-service";

afterEach(async () => {
  await db.costActual.deleteMany();
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

async function makeLineItem(description: string, department: string | null, qty: number, unitCost: number) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
  const lineItem = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description, department, qty, unitCost });
  return { lineItem, opportunityId: opportunity.id };
}

describe("recordCostActual", () => {
  it("rejects a cost actual with neither a lineItemId nor a taskId", async () => {
    // opportunityId is never read here -- the "must reference a LineItem
    // or a Task" throw happens before the ownership check would touch it.
    await expect(recordCostActual({ opportunityId: "unused", actualCost: 100 })).rejects.toThrow(/LineItem or a Task/);
  });

  it("records an actual cost against a line item", async () => {
    const { lineItem, opportunityId } = await makeLineItem("Plywood", "EF", 10, 20);
    const user = await db.user.create({ data: { name: "Estimator", email: `e-${Date.now()}@example.com` } });

    const actual = await recordCostActual({
      opportunityId,
      lineItemId: lineItem.id,
      actualCost: 250,
      source: "Vendor invoice #4412",
      recordedById: user.id,
    });

    expect(actual.lineItemId).toBe(lineItem.id);
    expect(actual.actualCost.toNumber()).toBe(250);
    expect(actual.recordedById).toBe(user.id);
  });

  it("is append-only -- multiple actuals accrue against the same line item", async () => {
    const { lineItem, opportunityId } = await makeLineItem("Plywood", "EF", 10, 20);
    await recordCostActual({ opportunityId, lineItemId: lineItem.id, actualCost: 150 });
    await recordCostActual({ opportunityId, lineItemId: lineItem.id, actualCost: 90 });

    const actuals = await db.costActual.findMany({ where: { lineItemId: lineItem.id } });
    expect(actuals).toHaveLength(2);
    expect(computeActualTotal(actuals).toNumber()).toBe(240);
  });

  it("rejects a lineItemId that belongs to a different opportunity than the caller's own", async () => {
    const { lineItem } = await makeLineItem("Plywood", "EF", 10, 20);
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(
      recordCostActual({ opportunityId: otherOpportunity.id, lineItemId: lineItem.id, actualCost: 100 }),
    ).rejects.toThrow();
  });
});

describe("computeLineItemVariance", () => {
  it("computes actual minus estimated per line item, defaulting to 0 actual when none recorded", () => {
    const rows = computeLineItemVariance([
      { id: "1", description: "Plywood", department: "EF", totalCost: 200, costActuals: [{ actualCost: 250 }] },
      { id: "2", description: "Design time", department: "DE", totalCost: 100, costActuals: [] },
    ]);

    expect(rows[0]).toMatchObject({ estimatedCost: expect.anything(), actualCost: expect.anything() });
    expect(rows[0].estimatedCost.toNumber()).toBe(200);
    expect(rows[0].actualCost.toNumber()).toBe(250);
    expect(rows[0].variance.toNumber()).toBe(50); // over budget

    expect(rows[1].actualCost.toNumber()).toBe(0);
    expect(rows[1].variance.toNumber()).toBe(-100); // no actuals recorded yet
  });
});

describe("computeDepartmentVariance", () => {
  it("rolls up variance by department, grouping missing departments as Unassigned", () => {
    const rows = computeLineItemVariance([
      { id: "1", description: "Plywood", department: "EF", totalCost: 200, costActuals: [{ actualCost: 250 }] },
      { id: "2", description: "More plywood", department: "EF", totalCost: 100, costActuals: [{ actualCost: 80 }] },
      { id: "3", description: "Fee", department: null, totalCost: 50, costActuals: [] },
    ]);

    const byDept = computeDepartmentVariance(rows);
    const ef = byDept.find((d) => d.department === "EF")!;
    const unassigned = byDept.find((d) => d.department === "Unassigned")!;

    expect(ef.estimatedCost.toNumber()).toBe(300);
    expect(ef.actualCost.toNumber()).toBe(330);
    expect(ef.variance.toNumber()).toBe(30);

    expect(unassigned.estimatedCost.toNumber()).toBe(50);
    expect(unassigned.actualCost.toNumber()).toBe(0);
    expect(unassigned.variance.toNumber()).toBe(-50);
  });
});
