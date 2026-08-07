import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addLineItem,
  addSection,
  createEstimateVersion,
  lockEstimateVersion,
  updateLineItem,
} from "@/lib/estimate-service";
import { approveEstimateVersion } from "@/lib/proposal-service";
import {
  approveChangeOrder,
  computeChangeOrderDiff,
  createChangeOrder,
  rejectChangeOrder,
} from "@/lib/change-order-service";

afterEach(async () => {
  await db.changeOrder.deleteMany();
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

async function makeApprovedVersion() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 50);
  const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
  await addLineItem(section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
  await lockEstimateVersion(version.id);
  const user = await db.user.create({ data: { name: "Approver", email: `a-${Date.now()}@example.com` } });
  await approveEstimateVersion(version.id, user.id);
  return { estimate, version, section, user };
}

describe("createChangeOrder", () => {
  it("rejects opening a change order against a non-approved version", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    await lockEstimateVersion(version.id);

    await expect(createChangeOrder(estimate.id, version.id, "Add flooring")).rejects.toThrow(
      /locked and approved/,
    );
  });

  it("opens an editable resultVersion copied from the approved base", async () => {
    const { estimate, version } = await makeApprovedVersion();
    const changeOrder = await createChangeOrder(estimate.id, version.id, "Add flooring upgrade");

    expect(changeOrder.baseVersionId).toBe(version.id);
    expect(changeOrder.status).toBe("DRAFT");

    const result = await db.estimateVersion.findUniqueOrThrow({ where: { id: changeOrder.resultVersionId } });
    expect(result.isLocked).toBe(false);
    expect(result.isCurrent).toBe(true);
    expect(result.totalCost.toNumber()).toBe(200); // copied from base
  });
});

describe("approveChangeOrder / rejectChangeOrder", () => {
  it("rejects approving before the result version is locked", async () => {
    const { estimate, version } = await makeApprovedVersion();
    const changeOrder = await createChangeOrder(estimate.id, version.id, "Add flooring");

    await expect(approveChangeOrder(changeOrder.id)).rejects.toThrow(/must be locked/);
  });

  it("approves once the result version is locked", async () => {
    const { estimate, version } = await makeApprovedVersion();
    const changeOrder = await createChangeOrder(estimate.id, version.id, "Add flooring");
    await lockEstimateVersion(changeOrder.resultVersionId);

    const approved = await approveChangeOrder(changeOrder.id);
    expect(approved.status).toBe("APPROVED");
    expect(approved.approvedAt).not.toBeNull();
  });

  it("rejectChangeOrder sets status to REJECTED without requiring a lock", async () => {
    const { estimate, version } = await makeApprovedVersion();
    const changeOrder = await createChangeOrder(estimate.id, version.id, "Add flooring");

    const rejected = await rejectChangeOrder(changeOrder.id);
    expect(rejected.status).toBe("REJECTED");
  });
});

describe("computeChangeOrderDiff", () => {
  it("classifies added, removed, and changed line items; omits unchanged ones", async () => {
    const { estimate, version } = await makeApprovedVersion();
    const changeOrder = await createChangeOrder(estimate.id, version.id, "Multiple changes");

    const resultSection = await db.estimateSection.findFirstOrThrow({
      where: { estimateVersionId: changeOrder.resultVersionId },
    });
    const resultLineItem = await db.lineItem.findFirstOrThrow({ where: { sectionId: resultSection.id } });

    // CHANGED: bump the copied Plywood line's qty
    await updateLineItem(resultLineItem.id, { qty: 15 });
    // ADDED: a brand-new line item on the result side
    await addLineItem(resultSection.id, { lineType: "MATERIAL", description: "Upgraded flooring", qty: 1, unitCost: 500 });

    const base = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    const result = await db.estimateSection.findMany({
      where: { estimateVersionId: changeOrder.resultVersionId },
      include: { lineItems: true },
    });

    const diff = computeChangeOrderDiff(base, result);
    const byDescription = Object.fromEntries(diff.map((row) => [row.description, row]));

    expect(byDescription["Plywood"]).toMatchObject({ kind: "CHANGED" });
    expect(byDescription["Plywood"].delta.toNumber()).toBe(100); // 300 - 200
    expect(byDescription["Upgraded flooring"]).toMatchObject({ kind: "ADDED" });
    expect(byDescription["Upgraded flooring"].delta.toNumber()).toBe(500);
    expect(diff).toHaveLength(2); // section name matches base row so no false REMOVED entries
  });

  it("classifies a removed line item when the base section is untouched but the row is dropped", () => {
    const base = [{ name: "COMPONENT 1", lineItems: [{ description: "Plywood", totalCost: 200 }] }];
    const result = [{ name: "COMPONENT 1", lineItems: [] }];

    const diff = computeChangeOrderDiff(base, result);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ kind: "REMOVED", description: "Plywood" });
    expect(diff[0].delta.toNumber()).toBe(-200);
  });

  it("returns no rows when base and result are identical", () => {
    const base = [{ name: "COMPONENT 1", lineItems: [{ description: "Plywood", totalCost: 200 }] }];
    const result = [{ name: "COMPONENT 1", lineItems: [{ description: "Plywood", totalCost: 200 }] }];

    expect(computeChangeOrderDiff(base, result)).toHaveLength(0);
  });
});
