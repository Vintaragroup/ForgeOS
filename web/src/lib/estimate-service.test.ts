import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  addAttachment,
  addLineItem,
  addLineItemsBulk,
  addOption,
  addSection,
  archiveEstimate,
  clearBoothPendingDescription,
  clearCategoryMarginOverride,
  clearSectionPendingDescription,
  computeLineItemTotal,
  computeMarginGrossUp,
  computeOptionTotal,
  computeSectionTotal,
  computeVersionTotals,
  confirmDraftLineItem,
  createBidPackage,
  createEstimateVersion,
  createNewVersionFromLocked,
  deleteLineItem,
  lockEstimateVersion,
  mergeBoothIntoAnotherBooth,
  moveElementGroupOrder,
  moveLineItemsToCategory,
  moveLineItemToEstimate,
  moveLineItemWithinSection,
  moveSectionOrder,
  moveSectionProposalOrder,
  recategorizeLineItems,
  recomputeVersionTotals,
  removeLineItemFromBidPackage,
  resolveBoothBuildType,
  restoreLineItem,
  setBidPackageStatus,
  setCategoryMarginOverride,
  unarchiveEstimate,
  updateBoothDescription,
  updateLineItem,
  updateMarginTarget,
  updateSectionDescription,
  updateSectionProposalVisibility,
} from "@/lib/estimate-service";

afterEach(async () => {
  await db.categoryMarginOverride.deleteMany();
  await db.lineItem.deleteMany();
  await db.attachment.deleteMany();
  await db.document.deleteMany();
  await db.bidPackage.deleteMany();
  await db.estimateSection.deleteMany();
  await db.option.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.category.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

function makeCategory(name: string, key: string) {
  return db.category.create({ data: { name, key } });
}

async function makeEstimate() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show" },
  });
  return db.estimate.create({ data: { opportunityId: opportunity.id } });
}

describe("computeLineItemTotal", () => {
  it("multiplies qty by unit cost", () => {
    expect(computeLineItemTotal(3, 12.5).toNumber()).toBe(37.5);
  });
});

describe("computeSectionTotal", () => {
  it("sums line item totals", () => {
    const total = computeSectionTotal([{ totalCost: 100 }, { totalCost: 250.5 }, { totalCost: 0 }]);
    expect(total.toNumber()).toBe(350.5);
  });

  it("returns 0 for an empty section", () => {
    expect(computeSectionTotal([]).toNumber()).toBe(0);
  });
});

// business-rules.md Rule 6, and docs/migration-plan.md Phase 3 scope item 4:
// "implement the cost / ((100-margin%)/100) formula exactly, with an
// explicit unit test asserting it is not accidentally simplified to a
// markup formula."
describe("computeMarginGrossUp", () => {
  it("matches Yoku Moku's real, client-sent grand total (Phase 1 validated)", () => {
    // cost and margin% independently recovered from Yoku Moku's real
    // recalculated workbook during Phase 1; grand total matches the real
    // sent proposal to the penny (docs/phase1-findings.md).
    const cost = 36060.684;
    const marginTargetPct = 45.3996887538702;
    const sell = computeMarginGrossUp(cost, marginTargetPct);
    expect(sell.toDecimalPlaces(2).toNumber()).toBeCloseTo(66044.83, 2);
  });

  it("is a gross-up, not a markup -- the two formulas diverge for any nonzero margin", () => {
    const cost = 1000;
    const marginTargetPct = 40;

    const grossUp = computeMarginGrossUp(cost, marginTargetPct);
    const markup = new Prisma.Decimal(cost).times(1 + marginTargetPct / 100);

    // gross-up: 1000 / 0.6 = 1666.67
    expect(grossUp.toDecimalPlaces(2).toNumber()).toBeCloseTo(1666.67, 2);
    // markup: 1000 * 1.4 = 1400 -- a different number entirely
    expect(markup.toNumber()).toBe(1400);
    expect(grossUp.toNumber()).not.toBeCloseTo(markup.toNumber(), 2);
  });

  it("agrees with markup only at margin = 0", () => {
    const grossUp = computeMarginGrossUp(500, 0);
    const markup = new Prisma.Decimal(500).times(1 + 0 / 100);
    expect(grossUp.toNumber()).toBe(markup.toNumber());
  });
});

describe("computeVersionTotals", () => {
  it("rolls up sections into totalCost and grosses up to grandTotal", () => {
    const totals = computeVersionTotals({
      marginTargetPct: 50,
      sections: [
        { groupLabel: null, buildType: null, lineItems: [{ totalCost: 100, category: null }, { totalCost: 200, category: null }] },
        { groupLabel: null, buildType: null, lineItems: [{ totalCost: 300, category: null }] },
      ],
    });

    expect(totals.totalCost.toNumber()).toBe(600);
    // 600 / ((100-50)/100) = 1200
    expect(totals.grandTotal.toNumber()).toBe(1200);
    // (1200-600)/1200 * 100 = 50 -- recovers the margin target independently
    expect(totals.grossMarginPct.toNumber()).toBe(50);
  });

  it("handles an estimate with no line items yet", () => {
    const totals = computeVersionTotals({ marginTargetPct: 30, sections: [] });
    expect(totals.totalCost.toNumber()).toBe(0);
    expect(totals.grandTotal.toNumber()).toBe(0);
    expect(totals.grossMarginPct.toNumber()).toBe(0);
  });

  it("grosses up each category at its own overridden margin instead of one global rate", () => {
    const categories = [
      { id: "structure", name: "Structure", key: "structure", parentId: null },
      { id: "labor", name: "Labor", key: "labor", parentId: null },
    ];
    const overrides = new Map([["structure", new Prisma.Decimal(0)]]);

    const totals = computeVersionTotals(
      {
        marginTargetPct: 50,
        sections: [
          {
            groupLabel: null,
            buildType: null,
            lineItems: [
              { totalCost: 100, category: "Structure" },
              { totalCost: 100, category: "Labor" },
            ],
          },
        ],
      },
      categories,
      overrides,
    );

    expect(totals.totalCost.toNumber()).toBe(200);
    // Structure grosses up at its 0% override (100/1 = 100); Labor at the
    // 50% document default (100/0.5 = 200) -- 300 total, not 400 (what a
    // single global 50% rate over the combined 200 cost would give).
    expect(totals.grandTotal.toNumber()).toBe(300);
  });

  it("falls back to the document target for a category with no override", () => {
    const categories = [{ id: "structure", name: "Structure", key: "structure", parentId: null }];

    const totals = computeVersionTotals(
      { marginTargetPct: 50, sections: [{ groupLabel: null, buildType: null, lineItems: [{ totalCost: 100, category: "Structure" }] }] },
      categories,
      new Map(),
    );

    expect(totals.grandTotal.toNumber()).toBe(200);
  });
});

describe("category margin overrides", () => {
  it("prices an overridden category at its own rate, blending into a real margin that differs from the document target", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const structure = await makeCategory("Structure", "structure");
    await makeCategory("Labor", "labor");
    const section = await addSection(version.id, { name: "Section 1", sectionType: "CATEGORY" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", category: "Structure", qty: 1, unitCost: 100 });
    await addLineItem(version.id, section.id, { lineType: "LABOR", description: "Install", category: "Labor", qty: 1, unitCost: 100 });

    await setCategoryMarginOverride(version.id, structure.id, 0);

    const updated = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(updated.totalCost.toNumber()).toBe(200);
    // Structure at its 0% override (100) + Labor at the 50% document
    // default (200) = 300, not 400 (what one global 50% rate would give).
    expect(updated.grandTotal.toNumber()).toBe(300);
    // The document's own target is untouched by setting an override --
    // it's the goal, not "the" margin.
    expect(updated.marginTargetPct.toNumber()).toBe(50);
    // The real, blended margin now differs from that target.
    expect(updated.grossMarginPct.toNumber()).toBeCloseTo(33.33, 1);
  });

  it("clearing an override reverts a category to the document target", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const structure = await makeCategory("Structure", "structure");
    const section = await addSection(version.id, { name: "Section 1", sectionType: "CATEGORY" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", category: "Structure", qty: 1, unitCost: 100 });

    await setCategoryMarginOverride(version.id, structure.id, 0);
    expect((await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } })).grandTotal.toNumber()).toBe(100);

    await clearCategoryMarginOverride(version.id, structure.id);
    expect((await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } })).grandTotal.toNumber()).toBe(200);
  });

  it("rejects setting or clearing an override on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const structure = await makeCategory("Structure", "structure");
    await lockEstimateVersion(version.id);

    await expect(setCategoryMarginOverride(version.id, structure.id, 0)).rejects.toThrow(/locked/);
    await expect(clearCategoryMarginOverride(version.id, structure.id)).rejects.toThrow(/locked/);
  });

  it("carries category margin overrides forward when creating a new version from a locked one", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const structure = await makeCategory("Structure", "structure");
    const section = await addSection(version.id, { name: "Section 1", sectionType: "CATEGORY" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", category: "Structure", qty: 1, unitCost: 100 });
    await setCategoryMarginOverride(version.id, structure.id, 0);
    await lockEstimateVersion(version.id);

    const newVersion = await createNewVersionFromLocked(version.id);

    const overrides = await db.categoryMarginOverride.findMany({ where: { estimateVersionId: newVersion.id } });
    expect(overrides).toHaveLength(1);
    expect(overrides[0].categoryId).toBe(structure.id);
    expect(overrides[0].marginPct.toNumber()).toBe(0);
  });
});

describe("estimate version lifecycle", () => {
  it("builds sections/line items and locks a version with computed totals", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);

    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });
    await addLineItem(version.id, section.id, {
      lineType: "LABOR",
      description: "Fabrication",
      department: "EF",
      qty: 5,
      unitCost: 38.71,
    });

    const locked = await lockEstimateVersion(version.id);

    expect(locked.isLocked).toBe(true);
    expect(locked.lockedAt).not.toBeNull();
    expect(locked.totalCost.toNumber()).toBeCloseTo(200 + 5 * 38.71, 2);
    // gross-up at 50% margin doubles cost
    expect(locked.grandTotal.toNumber()).toBeCloseTo(locked.totalCost.toNumber() * 2, 2);
  });

  it("rejects edits to a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await lockEstimateVersion(version.id);

    await expect(
      addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Late add", qty: 1, unitCost: 1 }),
    ).rejects.toThrow(/locked/);
  });

  it("recomputes totals live as line items change, without locking", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });

    let refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(200);
    expect(refreshed.isLocked).toBe(false);

    await updateLineItem(estimate.opportunityId, lineItem.id, { qty: 15 });
    refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(300);
  });

  it("only current version changes when a second version is created", async () => {
    const estimate = await makeEstimate();
    const v1 = await createEstimateVersion(estimate.id, 50);
    const v2 = await createEstimateVersion(estimate.id, 60);

    const refreshedV1 = await db.estimateVersion.findUniqueOrThrow({ where: { id: v1.id } });
    expect(refreshedV1.isCurrent).toBe(false);
    expect(v2.isCurrent).toBe(true);
    expect(v2.versionNumber).toBe(2);
  });

  it("copies a locked version's sections/line items into a new unlocked version", async () => {
    const estimate = await makeEstimate();
    const v1 = await createEstimateVersion(estimate.id, 50);
    const section = await addSection(v1.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(v1.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
    await lockEstimateVersion(v1.id);

    const v2 = await createNewVersionFromLocked(v1.id);

    expect(v2.isLocked).toBe(false);
    expect(v2.versionNumber).toBe(2);

    const v2Sections = await db.estimateSection.findMany({
      where: { estimateVersionId: v2.id },
      include: { lineItems: true },
    });
    expect(v2Sections).toHaveLength(1);
    expect(v2Sections[0].lineItems).toHaveLength(1);
    expect(v2Sections[0].lineItems[0].description).toBe("Plywood");

    // editable again post-copy
    await addLineItem(v2.id, v2Sections[0].id, { lineType: "MATERIAL", description: "Extra", qty: 1, unitCost: 5 });
  });

  it("carries over the source version's totals so the copy isn't shown as $0 before its first edit", async () => {
    const estimate = await makeEstimate();
    const v1 = await createEstimateVersion(estimate.id, 50);
    const section = await addSection(v1.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(v1.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
    const locked = await lockEstimateVersion(v1.id);

    const v2 = await createNewVersionFromLocked(v1.id);

    expect(v2.totalCost.toNumber()).toBe(locked.totalCost.toNumber());
    expect(v2.grandTotal.toNumber()).toBe(locked.grandTotal.toNumber());
    expect(v2.grossMarginPct.toNumber()).toBe(locked.grossMarginPct.toNumber());
  });

  it("updates margin target and recomputes totals in one call", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
    await recomputeVersionTotals(version.id);

    const updated = await updateMarginTarget(version.id, 60);
    expect(updated.marginTargetPct.toNumber()).toBe(60);
    // 200 / ((100-60)/100) = 500
    expect(updated.grandTotal.toNumber()).toBe(500);
  });

  it("deleteLineItem reports which version to recompute", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });

    const deleted = await deleteLineItem(estimate.opportunityId, lineItem.id);
    expect(deleted.estimateVersionId).toBe(version.id);

    const refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(0);
  });
});

describe("estimate archiving", () => {
  it("sets archivedAt, not deletedAt, and unarchive clears it again", async () => {
    const estimate = await makeEstimate();

    const archived = await archiveEstimate(estimate.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(archived.deletedAt).toBeNull();

    const unarchived = await unarchiveEstimate(estimate.id);
    expect(unarchived.archivedAt).toBeNull();
  });

  it("rejects a line-item edit on an archived estimate's version, and allows it again once unarchived", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });

    await archiveEstimate(estimate.id);

    await expect(
      addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Blocked", qty: 1, unitCost: 1 }),
    ).rejects.toThrow(/archived/);

    await unarchiveEstimate(estimate.id);

    await expect(
      addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Allowed", qty: 1, unitCost: 1 }),
    ).resolves.toBeDefined();
  });

  it("rejects creating a new version on an archived estimate", async () => {
    const estimate = await makeEstimate();
    await archiveEstimate(estimate.id);

    await expect(createEstimateVersion(estimate.id, 0)).rejects.toThrow(/archived/);
  });

  it("rejects copying a locked version forward on an archived estimate", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    await lockEstimateVersion(version.id);
    await archiveEstimate(estimate.id);

    await expect(createNewVersionFromLocked(version.id)).rejects.toThrow(/archived/);
  });
});

describe("line item audit log", () => {
  it("writes a CREATE row with the given actorId, and none at all when actorId is omitted (every existing import call site)", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const user = await db.user.create({ data: { name: "Estimator", email: `e-${Date.now()}@example.com` } });

    const withActor = await addLineItem(
      version.id,
      section.id,
      { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 },
      user.id,
    );
    const noActor = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Screws",
      qty: 1,
      unitCost: 5,
    });

    const logs = await db.lineItemAuditLog.findMany({ where: { estimateVersionId: version.id }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ action: "CREATE", lineItemId: withActor.id, description: "Plywood", actorId: user.id });
    expect(logs[1]).toMatchObject({ action: "CREATE", lineItemId: noActor.id, description: "Screws", actorId: null });
  });

  it("writes an UPDATE row containing only the changed fields, and no row at all when nothing actually changed", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });
    const user = await db.user.create({ data: { name: "Estimator", email: `e-${Date.now()}@example.com` } });

    // No-op save -- identical qty, nothing else passed. Must write nothing.
    await updateLineItem(estimate.opportunityId, lineItem.id, { qty: 10 }, user.id);
    expect(await db.lineItemAuditLog.count({ where: { estimateVersionId: version.id, action: "UPDATE" } })).toBe(0);

    await updateLineItem(estimate.opportunityId, lineItem.id, { qty: 15, description: "Plywood (revised)" }, user.id);

    const logs = await db.lineItemAuditLog.findMany({ where: { estimateVersionId: version.id, action: "UPDATE" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "UPDATE", lineItemId: lineItem.id, actorId: user.id });
    expect(logs[0].detail).toMatchObject({
      qty: { before: "10", after: "15" },
      description: { before: "Plywood", after: "Plywood (revised)" },
    });
    // Only the changed fields -- category was never touched, so it must
    // not appear in detail at all.
    expect(logs[0].detail).not.toHaveProperty("category");
  });

  it("writes a DELETE row with a full snapshot that survives the LineItem's own hard delete", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });
    const user = await db.user.create({ data: { name: "Estimator", email: `e-${Date.now()}@example.com` } });

    await deleteLineItem(estimate.opportunityId, lineItem.id, user.id);

    expect(await db.lineItem.findUnique({ where: { id: lineItem.id } })).toBeNull();

    const logs = await db.lineItemAuditLog.findMany({ where: { estimateVersionId: version.id } });
    // One CREATE (from addLineItem above) + one DELETE.
    const deleteLog = logs.find((l) => l.action === "DELETE");
    expect(deleteLog).toMatchObject({ lineItemId: lineItem.id, description: "Plywood", actorId: user.id });
    expect(deleteLog?.detail).toMatchObject({ qty: "10", unitCost: "20", totalCost: "200" });
  });

  it("writes exactly one summary row for a bulk import, regardless of item count", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const company = await db.company.create({ data: { name: "Doc Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Doc Show" } });
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Schedule.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "PRICING_SCHEDULE",
      },
    });

    await addLineItemsBulk(version.id, section.id, [
      { lineType: "MATERIAL", description: "Row 1", qty: 1, unitCost: 10, documentId: document.id },
      { lineType: "MATERIAL", description: "Row 2", qty: 1, unitCost: 10, documentId: document.id },
      { lineType: "MATERIAL", description: "Row 3", qty: 1, unitCost: 10, documentId: document.id },
    ]);

    const logs = await db.lineItemAuditLog.findMany({ where: { estimateVersionId: version.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "CREATE", lineItemId: null, actorId: null });
    expect(logs[0].detail).toMatchObject({ count: 3, documentId: document.id });

    await db.document.deleteMany({ where: { id: document.id } });
    await db.opportunity.deleteMany({ where: { id: opportunity.id } });
    await db.company.deleteMany({ where: { id: company.id } });
  });

  it("captures sectionId and sortOrder in the DELETE snapshot, not just cost fields", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });

    await deleteLineItem(estimate.opportunityId, lineItem.id);

    const deleteLog = await db.lineItemAuditLog.findFirstOrThrow({
      where: { estimateVersionId: version.id, action: "DELETE" },
    });
    expect(deleteLog.detail).toMatchObject({ sectionId: section.id, sortOrder: 0 });
  });
});

describe("restoreLineItem", () => {
  it("puts a deleted line item back in the same section at the same sortOrder, reusing its original id", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
      category: "Structure",
    });
    // Simulates a real drag-reordered position -- moveLineItemWithinSection
    // is what actually writes sortOrder in the app, but a direct update is
    // equivalent here and avoids needing a second sibling row.
    await db.lineItem.update({ where: { id: lineItem.id }, data: { sortOrder: 3 } });

    const user = await db.user.create({ data: { name: "Estimator", email: `e-${Date.now()}@example.com` } });
    const deleted = await deleteLineItem(estimate.opportunityId, lineItem.id, user.id);
    const deleteLog = await db.lineItemAuditLog.findFirstOrThrow({
      where: { estimateVersionId: version.id, action: "DELETE" },
    });

    const restored = await restoreLineItem(estimate.opportunityId, deleteLog.id, user.id);

    expect(restored.id).toBe(lineItem.id); // same id, not a fresh one
    expect(restored.estimateVersionId).toBe(deleted.estimateVersionId);

    const row = await db.lineItem.findUniqueOrThrow({ where: { id: lineItem.id } });
    expect(row.sectionId).toBe(section.id);
    expect(row.sortOrder).toBe(3);
    expect(row.description).toBe("Plywood");
    expect(row.category).toBe("Structure");
    expect(row.qty.toNumber()).toBe(10);
    expect(row.unitCost.toNumber()).toBe(20);

    const restoreLog = await db.lineItemAuditLog.findFirstOrThrow({
      where: { estimateVersionId: version.id, action: "RESTORE" },
    });
    expect(restoreLog).toMatchObject({ lineItemId: lineItem.id, actorId: user.id });
    expect(restoreLog.detail).toMatchObject({ restoredFromAuditLogId: deleteLog.id });
  });

  it("rejects restoring the same deletion twice", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 1, unitCost: 1 });
    await deleteLineItem(estimate.opportunityId, lineItem.id);
    const deleteLog = await db.lineItemAuditLog.findFirstOrThrow({
      where: { estimateVersionId: version.id, action: "DELETE" },
    });

    await restoreLineItem(estimate.opportunityId, deleteLog.id);

    await expect(restoreLineItem(estimate.opportunityId, deleteLog.id)).rejects.toThrow(/already been restored/);
  });

  it("rejects restoring into a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 1, unitCost: 1 });
    await deleteLineItem(estimate.opportunityId, lineItem.id);
    const deleteLog = await db.lineItemAuditLog.findFirstOrThrow({
      where: { estimateVersionId: version.id, action: "DELETE" },
    });

    await lockEstimateVersion(version.id);

    await expect(restoreLineItem(estimate.opportunityId, deleteLog.id)).rejects.toThrow(/locked/);
  });

  it("rejects restoring when the original section no longer exists", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 1, unitCost: 1 });
    await deleteLineItem(estimate.opportunityId, lineItem.id);
    const deleteLog = await db.lineItemAuditLog.findFirstOrThrow({
      where: { estimateVersionId: version.id, action: "DELETE" },
    });

    await db.estimateSection.delete({ where: { id: section.id } });

    await expect(restoreLineItem(estimate.opportunityId, deleteLog.id)).rejects.toThrow(/section .* no longer exists/i);
  });

  it("rejects restoring a DELETE row recorded before the snapshot included location", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    // A pre-widening snapshot -- exactly deleteLineItem's old, narrower
    // shape, with no sectionId/sortOrder at all.
    const oldStyleLog = await db.lineItemAuditLog.create({
      data: {
        estimateVersionId: version.id,
        lineItemId: "old-item-id",
        description: "Legacy row",
        action: "DELETE",
        detail: { category: "Structure", lineType: "MATERIAL", qty: "1", unitCost: "1", totalCost: "1" },
      },
    });

    await expect(restoreLineItem(estimate.opportunityId, oldStyleLog.id)).rejects.toThrow(/predates the restore feature/);
  });
});

describe("Option (alternates)", () => {
  it("an Option's sections are priced separately from the base estimate total", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const baseSection = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(version.id, baseSection.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });

    const option = await addOption(version.id, { name: "Option 1: Upgraded flooring" });
    const optionSection = await addSection(version.id, {
      name: "COMPONENT 1 (Option 1)",
      sectionType: "COMPONENT",
      optionId: option.id,
    });
    await addLineItem(version.id, optionSection.id, {
      lineType: "MATERIAL",
      description: "Premium flooring",
      qty: 1,
      unitCost: 500,
    });

    // base total unaffected by the Option's line items
    const refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(200);

    const optionSections = await db.estimateSection.findMany({
      where: { optionId: option.id },
      include: { lineItems: true },
    });
    expect(computeOptionTotal(optionSections).toNumber()).toBe(500);
  });

  it("rejects adding an Option or its sections to a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    await lockEstimateVersion(version.id);

    await expect(addOption(version.id, { name: "Option 1" })).rejects.toThrow(/locked/);
  });

  it("copies Options and their sections when creating a new version from a locked one", async () => {
    const estimate = await makeEstimate();
    const v1 = await createEstimateVersion(estimate.id, 50);
    const option = await addOption(v1.id, { name: "Option 1: Upgraded flooring" });
    const optionSection = await addSection(v1.id, {
      name: "COMPONENT 1 (Option 1)",
      sectionType: "COMPONENT",
      optionId: option.id,
    });
    await addLineItem(v1.id, optionSection.id, {
      lineType: "MATERIAL",
      description: "Premium flooring",
      qty: 1,
      unitCost: 500,
    });
    await lockEstimateVersion(v1.id);

    const v2 = await createNewVersionFromLocked(v1.id);

    const v2Options = await db.option.findMany({
      where: { estimateVersionId: v2.id },
      include: { sections: { include: { lineItems: true } } },
    });
    expect(v2Options).toHaveLength(1);
    expect(v2Options[0].name).toBe("Option 1: Upgraded flooring");
    expect(v2Options[0].sections).toHaveLength(1);
    expect(v2Options[0].sections[0].lineItems[0].description).toBe("Premium flooring");
    // copied sections stay linked to the copied estimate version too
    expect(v2Options[0].sections[0].estimateVersionId).toBe(v2.id);
  });
});

describe("Bid packages", () => {
  it("groups a freeform, cross-category set of line items into a bid package", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const structureSection = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const laborSection = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });
    const structureItem = await addLineItem(version.id, structureSection.id, {
      lineType: "MATERIAL",
      description: "Truss accessories",
      qty: 1,
      unitCost: 0,
    });
    const laborItem = await addLineItem(version.id, laborSection.id, {
      lineType: "LABOR",
      description: "Installation labor for scaffolding",
      qty: 1,
      unitCost: 0,
    });

    const bidPackage = await createBidPackage(version.id, {
      name: "Scaffolding, Platforms & Truss",
      vendorName: "ShowRig",
      lineItemIds: [structureItem.id, laborItem.id],
    });

    expect(bidPackage.status).toBe("AWAITING_QUOTE");
    const updated = await db.lineItem.findMany({ where: { id: { in: [structureItem.id, laborItem.id] } } });
    expect(updated.every((li) => li.bidPackageId === bidPackage.id)).toBe(true);
  });

  it("rejects an empty selection", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    await expect(createBidPackage(version.id, { name: "Empty", lineItemIds: [] })).rejects.toThrow(
      "Select at least one line item",
    );
  });

  it("rejects a line item that belongs to a different estimate version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "A", qty: 1, unitCost: 0 });

    const otherEstimate = await makeEstimate();
    const otherVersion = await createEstimateVersion(otherEstimate.id, 0);
    const otherSection = await addSection(otherVersion.id, { name: "Structure", sectionType: "CATEGORY" });
    const otherItem = await addLineItem(otherVersion.id, otherSection.id, {
      lineType: "MATERIAL",
      description: "B",
      qty: 1,
      unitCost: 0,
    });

    await expect(
      createBidPackage(version.id, { name: "Cross-version", lineItemIds: [item.id, otherItem.id] }),
    ).rejects.toThrow("don't belong to this estimate version");
  });

  it("rejects creating a bid package on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "A", qty: 1, unitCost: 0 });
    await lockEstimateVersion(version.id);

    await expect(createBidPackage(version.id, { name: "Locked", lineItemIds: [item.id] })).rejects.toThrow(/locked/);
  });

  it("removeLineItemFromBidPackage clears only the targeted item's assignment", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const itemA = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "A", qty: 1, unitCost: 0 });
    const itemB = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "B", qty: 1, unitCost: 0 });
    await createBidPackage(version.id, { name: "Package", lineItemIds: [itemA.id, itemB.id] });

    await removeLineItemFromBidPackage(estimate.opportunityId, itemA.id);

    const [refreshedA, refreshedB] = await Promise.all([
      db.lineItem.findUniqueOrThrow({ where: { id: itemA.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: itemB.id } }),
    ]);
    expect(refreshedA.bidPackageId).toBeNull();
    expect(refreshedB.bidPackageId).not.toBeNull();
  });

  it("setBidPackageStatus updates the package's status", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "A", qty: 1, unitCost: 0 });
    const bidPackage = await createBidPackage(version.id, { name: "Package", lineItemIds: [item.id] });

    const updated = await setBidPackageStatus(bidPackage.id, "QUOTE_RECEIVED");
    expect(updated.status).toBe("QUOTE_RECEIVED");
  });

  it("updateLineItem stamps vendor-match provenance and flips isDraft on apply", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Flooring", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Sleeper Floor Required",
      qty: 1,
      unitCost: 0,
      isDraft: true,
    });
    const document = await db.document.create({
      data: {
        opportunityId: estimate.opportunityId,
        filename: "ShowRig quote.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "test/key",
        documentType: "VENDOR_QUOTE",
      },
    });

    const updated = await updateLineItem(estimate.opportunityId, item.id, {
      unitCost: 840,
      documentId: document.id,
      sourceQuote: "Sleeper Floor",
      isDraft: false,
    });

    expect(updated.unitCost.toNumber()).toBe(840);
    expect(updated.totalCost.toNumber()).toBe(840);
    expect(updated.documentId).toBe(document.id);
    expect(updated.sourceQuote).toBe("Sleeper Floor");
    expect(updated.isDraft).toBe(false);
  });
});

describe("moveLineItemsToCategory -- lineItemIds scope", () => {
  it("moves an arbitrary, cross-section set of selected items to a new category", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const sectionA = await addSection(version.id, { name: "Platform", sectionType: "CATEGORY" });
    const sectionB = await addSection(version.id, { name: "Other Platform", sectionType: "CATEGORY" });
    const itemA = await addLineItem(version.id, sectionA.id, {
      lineType: "MATERIAL",
      description: "Sleeper Floor Required 1\"",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });
    const itemB = await addLineItem(version.id, sectionB.id, {
      lineType: "MATERIAL",
      description: "Sleeper Floor Required 1\"",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });
    // Deliberately left off the selection -- only the two chosen items
    // should move, not every item sharing their old category.
    const untouched = await addLineItem(version.id, sectionA.id, {
      lineType: "MATERIAL",
      description: "FR Carpet",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    await moveLineItemsToCategory(version.id, { lineItemIds: [itemA.id, itemB.id] }, "Structure");

    const moved = await db.lineItem.findMany({ where: { id: { in: [itemA.id, itemB.id] } } });
    expect(moved.every((li) => li.category === "Structure")).toBe(true);
    const stillFlooring = await db.lineItem.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(stillFlooring.category).toBe("Flooring");
  });

  it("only moves items belonging to the given estimate version, even if a foreign id is included", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "A",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    const otherEstimate = await makeEstimate();
    const otherVersion = await createEstimateVersion(otherEstimate.id, 0);
    const otherSection = await addSection(otherVersion.id, { name: "Structure", sectionType: "CATEGORY" });
    const otherItem = await addLineItem(otherVersion.id, otherSection.id, {
      lineType: "MATERIAL",
      description: "B",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    await moveLineItemsToCategory(version.id, { lineItemIds: [item.id, otherItem.id] }, "Structure");

    const movedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(movedItem.category).toBe("Structure");
    const untouchedForeignItem = await db.lineItem.findUniqueOrThrow({ where: { id: otherItem.id } });
    expect(untouchedForeignItem.category).toBe("Flooring");
  });

  it("rejects moving items on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "A",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });
    await lockEstimateVersion(version.id);

    await expect(moveLineItemsToCategory(version.id, { lineItemIds: [item.id] }, "Structure")).rejects.toThrow(
      /locked/,
    );
  });
});

describe("moveLineItemsToCategory -- sectionId scope", () => {
  it("moves every item in one section to a new category", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Platform", sectionType: "CATEGORY" });
    const itemA = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Sleeper Floor Required 1\"",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });
    const itemB = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "FR Carpet",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    await moveLineItemsToCategory(version.id, { sectionId: section.id }, "Structure");

    const moved = await db.lineItem.findMany({ where: { id: { in: [itemA.id, itemB.id] } } });
    expect(moved.every((li) => li.category === "Structure")).toBe(true);
  });

  it("does not touch a different section in the same version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Platform", sectionType: "CATEGORY" });
    const otherSection = await addSection(version.id, { name: "Other Platform", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "A",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });
    const untouched = await addLineItem(version.id, otherSection.id, {
      lineType: "MATERIAL",
      description: "B",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    await moveLineItemsToCategory(version.id, { sectionId: section.id }, "Structure");

    const movedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(movedItem.category).toBe("Structure");
    const untouchedItem = await db.lineItem.findUniqueOrThrow({ where: { id: untouched.id } });
    expect(untouchedItem.category).toBe("Flooring");
  });

  it("does not touch a same-named section in a different version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    const item = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "A",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    const otherEstimate = await makeEstimate();
    const otherVersion = await createEstimateVersion(otherEstimate.id, 0);
    const otherSection = await addSection(otherVersion.id, { name: "Structure", sectionType: "CATEGORY" });
    const otherItem = await addLineItem(otherVersion.id, otherSection.id, {
      lineType: "MATERIAL",
      description: "B",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });

    await moveLineItemsToCategory(version.id, { sectionId: section.id }, "Structure");

    const movedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(movedItem.category).toBe("Structure");
    const untouchedForeignItem = await db.lineItem.findUniqueOrThrow({ where: { id: otherItem.id } });
    expect(untouchedForeignItem.category).toBe("Flooring");
  });

  it("rejects moving a section's items on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Structure", sectionType: "CATEGORY" });
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "A",
      category: "Flooring",
      qty: 1,
      unitCost: 0,
    });
    await lockEstimateVersion(version.id);

    await expect(moveLineItemsToCategory(version.id, { sectionId: section.id }, "Structure")).rejects.toThrow(
      /locked/,
    );
  });
});

describe("moveLineItemsToCategory -- groupLabel scope", () => {
  async function makeMultiSectionBooth() {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const sectionA = await addSection(version.id, {
      name: "Booth Build",
      sectionType: "CATEGORY",
      groupLabel: "Section 203 - Camera Booth",
    });
    const sectionB = await addSection(version.id, {
      name: "Graphics",
      sectionType: "CATEGORY",
      groupLabel: "Section 203 - Camera Booth",
    });
    const otherSection = await addSection(version.id, {
      name: "Booth Build",
      sectionType: "CATEGORY",
      groupLabel: "Section 231 - Booth",
    });
    const itemA = await addLineItem(version.id, sectionA.id, {
      lineType: "MATERIAL",
      description: "PVC sheet",
      category: "Other",
      qty: 1,
      unitCost: 0,
    });
    const itemB = await addLineItem(version.id, sectionB.id, {
      lineType: "MATERIAL",
      description: "Vinyl graphic panel",
      category: "Other",
      qty: 1,
      unitCost: 0,
    });
    const untouched = await addLineItem(version.id, otherSection.id, {
      lineType: "MATERIAL",
      description: "Unrelated booth item",
      category: "Other",
      qty: 1,
      unitCost: 0,
    });
    return { version, itemA, itemB, untouched };
  }

  it("moves every item across every section sharing the booth's groupLabel, leaving other booths untouched", async () => {
    const { version, itemA, itemB, untouched } = await makeMultiSectionBooth();

    await moveLineItemsToCategory(version.id, { groupLabel: "Section 203 - Camera Booth" }, "Graphics");

    const [movedA, movedB, unaffected] = await Promise.all([
      db.lineItem.findUniqueOrThrow({ where: { id: itemA.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: itemB.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: untouched.id } }),
    ]);
    expect(movedA.category).toBe("Graphics");
    expect(movedB.category).toBe("Graphics");
    expect(unaffected.category).toBe("Other");
  });

  it("rejects moving a booth's items on a locked version", async () => {
    const { version } = await makeMultiSectionBooth();
    await lockEstimateVersion(version.id);

    await expect(
      moveLineItemsToCategory(version.id, { groupLabel: "Section 203 - Camera Booth" }, "Graphics"),
    ).rejects.toThrow(/locked/);
  });
});

describe("mergeBoothIntoAnotherBooth", () => {
  async function makeTwoBooths() {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const sourceSection = await addSection(version.id, {
      name: "Booth Build",
      sectionType: "CATEGORY",
      groupLabel: "Section 203 - Camera Booth",
    });
    await db.estimateSection.update({
      where: { id: sourceSection.id },
      data: { boothDescription: "The camera booth", boothPendingDescription: "AI-suggested text" },
    });
    const targetSection = await addSection(version.id, {
      name: "Booth Build",
      sectionType: "CATEGORY",
      groupLabel: "Section 203 - Booth",
    });
    const unrelatedSection = await addSection(version.id, {
      name: "Booth Build",
      sectionType: "CATEGORY",
      groupLabel: "Section 231 - Booth",
    });
    const item = await addLineItem(version.id, sourceSection.id, {
      lineType: "MATERIAL",
      description: "PVC sheet",
      qty: 1,
      unitCost: 0,
    });
    return { version, sourceSection, targetSection, unrelatedSection, item };
  }

  it("moves every section sharing the source groupLabel onto the target, clearing their booth description", async () => {
    const { version, sourceSection, targetSection, unrelatedSection } = await makeTwoBooths();

    await mergeBoothIntoAnotherBooth(version.id, "Section 203 - Camera Booth", "Section 203 - Booth");

    const [merged, target, unrelated] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: sourceSection.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: targetSection.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: unrelatedSection.id } }),
    ]);
    expect(merged.groupLabel).toBe("Section 203 - Booth");
    expect(merged.boothDescription).toBeNull();
    expect(merged.boothPendingDescription).toBeNull();
    expect(target.groupLabel).toBe("Section 203 - Booth");
    expect(unrelated.groupLabel).toBe("Section 231 - Booth");
  });

  it("keeps the moved section's own line items intact", async () => {
    const { version, item } = await makeTwoBooths();

    await mergeBoothIntoAnotherBooth(version.id, "Section 203 - Camera Booth", "Section 203 - Booth");

    const stillThere = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stillThere.description).toBe("PVC sheet");
  });

  it("rejects merging a booth into itself", async () => {
    const { version } = await makeTwoBooths();

    await expect(
      mergeBoothIntoAnotherBooth(version.id, "Section 203 - Camera Booth", "Section 203 - Camera Booth"),
    ).rejects.toThrow(/different booth/);
  });

  it("rejects merging into a target groupLabel that doesn't exist on this version", async () => {
    const { version } = await makeTwoBooths();

    await expect(
      mergeBoothIntoAnotherBooth(version.id, "Section 203 - Camera Booth", "Nonexistent Booth"),
    ).rejects.toThrow(/not found/);
  });

  it("rejects merging on a locked version", async () => {
    const { version } = await makeTwoBooths();
    await lockEstimateVersion(version.id);

    await expect(
      mergeBoothIntoAnotherBooth(version.id, "Section 203 - Camera Booth", "Section 203 - Booth"),
    ).rejects.toThrow(/locked/);
  });
});

describe("addSection -- buildType / resolveBoothBuildType", () => {
  it("persists buildType when creating a section with a new groupLabel", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);

    const section = await addSection(version.id, {
      name: "Booth Build",
      sectionType: "COMPONENT",
      groupLabel: "Section 500 - New Booth",
      buildType: "RENTAL",
    });

    const stored = await db.estimateSection.findUniqueOrThrow({ where: { id: section.id } });
    expect(stored.groupLabel).toBe("Section 500 - New Booth");
    expect(stored.buildType).toBe("RENTAL");
  });

  it("defaults buildType to null when omitted, same as before this field existed", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);

    const section = await addSection(version.id, { name: "Plain section", sectionType: "FEE" });

    const stored = await db.estimateSection.findUniqueOrThrow({ where: { id: section.id } });
    expect(stored.buildType).toBeNull();
  });

  it("resolveBoothBuildType returns null for a groupLabel nothing carries yet", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);

    expect(await resolveBoothBuildType(version.id, "Never Created")).toBeNull();
  });

  it("resolveBoothBuildType returns the existing booth's real buildType, for inheriting into a new sibling section", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    await addSection(version.id, {
      name: "Booth Build",
      sectionType: "COMPONENT",
      groupLabel: "Section 500 - New Booth",
      buildType: "CUSTOM_BUILD",
    });

    expect(await resolveBoothBuildType(version.id, "Section 500 - New Booth")).toBe("CUSTOM_BUILD");
  });

  it("resolveBoothBuildType is scoped to its own estimate version", async () => {
    const estimate = await makeEstimate();
    const v1 = await createEstimateVersion(estimate.id, 0);
    const v2 = await createEstimateVersion(estimate.id, 0);
    await addSection(v1.id, {
      name: "Booth Build",
      sectionType: "COMPONENT",
      groupLabel: "Section 500 - New Booth",
      buildType: "PURCHASE",
    });

    expect(await resolveBoothBuildType(v2.id, "Section 500 - New Booth")).toBeNull();
  });
});

describe("recategorizeLineItems", () => {
  it("rejects recategorizing a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Platform", sectionType: "CATEGORY" });
    await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Uncategorized item",
      qty: 1,
      unitCost: 0,
    });
    await lockEstimateVersion(version.id);

    await expect(recategorizeLineItems(estimate.opportunityId, version.id)).rejects.toThrow(/locked/);
  });
});

describe("design-intake prototype: draft line items + Attachment", () => {
  it("excludes draft line items from section/version totals until confirmed", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const attachment = await addAttachment(estimate.id, { fileRef: "pull-sheet-v1.pdf" });

    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Confirmed line", qty: 1, unitCost: 100 });
    const draft = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Drafted from pull sheet",
      qty: 1,
      unitCost: 900,
      isDraft: true,
      attachmentId: attachment.id,
    });

    let refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(100); // draft's $900 excluded

    await confirmDraftLineItem(estimate.opportunityId, draft.id);
    refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(1000); // now counts
  });

  it("rejects confirming a draft on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const draft = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "Drafted",
      qty: 1,
      unitCost: 100,
      isDraft: true,
    });
    await lockEstimateVersion(version.id);

    await expect(confirmDraftLineItem(estimate.opportunityId, draft.id)).rejects.toThrow(/locked/);
  });
});

describe("moveLineItemWithinSection", () => {
  async function makeMixedCategorySection() {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Booth Build", sectionType: "CATEGORY" });
    // One EstimateSection holding items from several resolved categories,
    // matching a real booth section -- the exact shape that reproduced the
    // bug live: the two Custom Build items a user sees together in that
    // tab are NOT adjacent in the section's raw sortOrder sequence.
    const structure1 = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL", description: "Structure item 1", category: "Structure", qty: 1, unitCost: 10,
    });
    const customBuild1 = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL", description: "Custom build item 1", category: "Custom Build / Rental", qty: 1, unitCost: 20,
    });
    const structure2 = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL", description: "Structure item 2", category: "Structure", qty: 1, unitCost: 30,
    });
    const customBuild2 = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL", description: "Custom build item 2", category: "Custom Build / Rental", qty: 1, unitCost: 40,
    });
    return { opportunity, section, structure1, customBuild1, structure2, customBuild2 };
  }

  it("swaps only the two visible sibling ids, leaving an interleaved invisible item's sortOrder untouched", async () => {
    const { opportunity, structure1, customBuild1, structure2, customBuild2 } = await makeMixedCategorySection();
    // Same shape as the UI's own category-filtered list -- only the two
    // Custom Build items, not the Structure items interleaved between them.
    const visibleSiblingIds = [customBuild1.id, customBuild2.id];

    await moveLineItemWithinSection(opportunity.id, customBuild1.id, "down", visibleSiblingIds);

    const [refreshed1, refreshed2, refreshedStructure1, refreshedStructure2] = await Promise.all([
      db.lineItem.findUniqueOrThrow({ where: { id: customBuild1.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: customBuild2.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: structure1.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: structure2.id } }),
    ]);
    // The two visible items swapped sortOrder with EACH OTHER...
    expect(refreshed1.sortOrder).toBe(customBuild2.sortOrder);
    expect(refreshed2.sortOrder).toBe(customBuild1.sortOrder);
    // ...and the invisible Structure items in between were never touched --
    // this is exactly what broke before: moving customBuild1 "down" used to
    // swap it with structure2 (the next item in the raw, cross-category
    // order), not with the other Custom Build row the user was looking at.
    expect(refreshedStructure1.sortOrder).toBe(structure1.sortOrder);
    expect(refreshedStructure2.sortOrder).toBe(structure2.sortOrder);
  });

  it("is a no-op past either end of the visible sibling list", async () => {
    const { opportunity, customBuild1, customBuild2 } = await makeMixedCategorySection();
    const visibleSiblingIds = [customBuild1.id, customBuild2.id];

    await moveLineItemWithinSection(opportunity.id, customBuild1.id, "up", visibleSiblingIds);
    await moveLineItemWithinSection(opportunity.id, customBuild2.id, "down", visibleSiblingIds);

    const [refreshed1, refreshed2] = await Promise.all([
      db.lineItem.findUniqueOrThrow({ where: { id: customBuild1.id } }),
      db.lineItem.findUniqueOrThrow({ where: { id: customBuild2.id } }),
    ]);
    expect(refreshed1.sortOrder).toBe(customBuild1.sortOrder);
    expect(refreshed2.sortOrder).toBe(customBuild2.sortOrder);
  });

  it("rejects a visible sibling id that doesn't actually belong to lineItemId's own section", async () => {
    const { opportunity, customBuild1 } = await makeMixedCategorySection();
    const company = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Other Show" } });
    const otherEstimate = await db.estimate.create({ data: { opportunityId: otherOpportunity.id } });
    const otherVersion = await createEstimateVersion(otherEstimate.id, 0);
    const otherSection = await addSection(otherVersion.id, { name: "Unrelated", sectionType: "CATEGORY" });
    const foreignItem = await addLineItem(otherVersion.id, otherSection.id, {
      lineType: "MATERIAL", description: "Foreign item", qty: 1, unitCost: 999,
    });
    const foreignSortOrderBefore = foreignItem.sortOrder;

    // A tampered/stale sibling list naming an item from a completely
    // different section -- must not let the swap reach across sections.
    await moveLineItemWithinSection(opportunity.id, customBuild1.id, "down", [customBuild1.id, foreignItem.id]);

    const refreshedForeign = await db.lineItem.findUniqueOrThrow({ where: { id: foreignItem.id } });
    expect(refreshedForeign.sortOrder).toBe(foreignSortOrderBefore);
  });

  it("rejects a lineItemId that belongs to a different opportunity", async () => {
    const { customBuild1 } = await makeMixedCategorySection();
    const company = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Other Show" } });
    await expect(
      moveLineItemWithinSection(otherOpportunity.id, customBuild1.id, "up", [customBuild1.id]),
    ).rejects.toThrow();
  });
});

describe("moveLineItemToEstimate", () => {
  async function makeTwoEstimates() {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const estimateA = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Estimate A" } });
    const estimateB = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Estimate B" } });
    const versionA = await createEstimateVersion(estimateA.id, 0);
    const versionB = await createEstimateVersion(estimateB.id, 0);
    return { opportunity, estimateA, estimateB, versionA, versionB };
  }

  it("moves a line item into the target estimate's current version, creating a matching section, and recomputes both totals", async () => {
    const { opportunity, estimateB, versionA, versionB } = await makeTwoEstimates();
    const sectionA = await addSection(versionA.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Door", qty: 1, unitCost: 500 });

    const result = await moveLineItemToEstimate(opportunity.id, item.id, estimateB.id);
    expect(result.fromEstimateVersionId).toBe(versionA.id);
    expect(result.toEstimateVersionId).toBe(versionB.id);

    const refreshedA = await recomputeVersionTotals(versionA.id);
    const refreshedB = await recomputeVersionTotals(versionB.id);
    expect(refreshedA.totalCost.toNumber()).toBe(0);
    expect(refreshedB.totalCost.toNumber()).toBe(500);

    const sectionsB = await db.estimateSection.findMany({ where: { estimateVersionId: versionB.id } });
    expect(sectionsB).toHaveLength(1);
    expect(sectionsB[0].name).toBe("Doors & Hardware");
    const movedItem = await db.lineItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(movedItem.sectionId).toBe(sectionsB[0].id);
  });

  it("reuses an existing same-named section in the target estimate instead of creating a duplicate", async () => {
    const { opportunity, estimateB, versionA, versionB } = await makeTwoEstimates();
    const sectionA = await addSection(versionA.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Door", qty: 1, unitCost: 500 });
    const existingSectionB = await addSection(versionB.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    await addLineItem(versionB.id, existingSectionB.id, { lineType: "MATERIAL", description: "Existing hinge", qty: 1, unitCost: 25 });

    await moveLineItemToEstimate(opportunity.id, item.id, estimateB.id);

    const sectionsB = await db.estimateSection.findMany({ where: { estimateVersionId: versionB.id } });
    expect(sectionsB).toHaveLength(1);
    const itemsInSection = await db.lineItem.findMany({ where: { sectionId: existingSectionB.id } });
    expect(itemsInSection).toHaveLength(2);
  });

  it("rejects moving out of a locked source version", async () => {
    const { opportunity, estimateB, versionA } = await makeTwoEstimates();
    const sectionA = await addSection(versionA.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Door", qty: 1, unitCost: 500 });
    await lockEstimateVersion(versionA.id);

    await expect(moveLineItemToEstimate(opportunity.id, item.id, estimateB.id)).rejects.toThrow(/locked/);
  });

  it("rejects moving into a locked target version", async () => {
    const { opportunity, estimateB, versionA, versionB } = await makeTwoEstimates();
    const sectionA = await addSection(versionA.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Door", qty: 1, unitCost: 500 });
    await lockEstimateVersion(versionB.id);

    await expect(moveLineItemToEstimate(opportunity.id, item.id, estimateB.id)).rejects.toThrow(/locked/);
  });

  it("rejects moving a line item using an opportunityId that isn't the item's real owning opportunity", async () => {
    const { estimateB, versionA } = await makeTwoEstimates();
    const sectionA = await addSection(versionA.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Door", qty: 1, unitCost: 500 });
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(moveLineItemToEstimate(otherOpportunity.id, item.id, estimateB.id)).rejects.toThrow();
  });

  it("rejects moving a line item INTO a targetEstimateId that belongs to a different opportunity than the caller's own", async () => {
    const { opportunity, versionA } = await makeTwoEstimates();
    const sectionA = await addSection(versionA.id, { name: "Doors & Hardware", sectionType: "CATEGORY" });
    const item = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Door", qty: 1, unitCost: 500 });
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });
    const foreignEstimate = await db.estimate.create({ data: { opportunityId: otherOpportunity.id } });
    await createEstimateVersion(foreignEstimate.id, 0);

    await expect(moveLineItemToEstimate(opportunity.id, item.id, foreignEstimate.id)).rejects.toThrow();
  });
});

// Regression tests for the cross-resource ID authorization gap found
// while auditing this file: requireEstimateAccess only checks the caller
// can access estimateId -- these functions previously trusted a
// lineItemId/sectionId/versionId taken from a form directly, letting any
// caller with access to SOME estimate mutate a DIFFERENT (inaccessible)
// estimate's line items/sections just by supplying its ID. See each
// function's own header comment in estimate-service.ts.
describe("opportunity-ownership checks (cross-resource ID authorization)", () => {
  async function makeTwoOpportunities() {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunityA = await db.opportunity.create({ data: { companyId: company.id, showName: "Show A" } });
    const opportunityB = await db.opportunity.create({ data: { companyId: company.id, showName: "Show B" } });
    const estimateA = await db.estimate.create({ data: { opportunityId: opportunityA.id } });
    const estimateB = await db.estimate.create({ data: { opportunityId: opportunityB.id } });
    const versionA = await createEstimateVersion(estimateA.id, 0);
    const versionB = await createEstimateVersion(estimateB.id, 0);
    const sectionA = await addSection(versionA.id, { name: "Section A", sectionType: "CATEGORY" });
    const sectionB = await addSection(versionB.id, { name: "Section B", sectionType: "CATEGORY" });
    const itemA = await addLineItem(versionA.id, sectionA.id, { lineType: "MATERIAL", description: "Item A", qty: 1, unitCost: 100 });
    return { opportunityA, opportunityB, sectionA, sectionB, itemA };
  }

  it("addLineItem rejects a sectionId that doesn't belong to the given estimateVersionId", async () => {
    const { sectionB } = await makeTwoOpportunities();
    const company = await db.company.create({ data: { name: "Another Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Another Show" } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await expect(
      addLineItem(version.id, sectionB.id, { lineType: "MATERIAL", description: "Injected", qty: 1, unitCost: 1 }),
    ).rejects.toThrow();
  });

  it("updateLineItem rejects a lineItemId that belongs to a different opportunity", async () => {
    const { opportunityB, itemA } = await makeTwoOpportunities();
    await expect(updateLineItem(opportunityB.id, itemA.id, { qty: 99 })).rejects.toThrow();
  });

  it("deleteLineItem rejects a lineItemId that belongs to a different opportunity", async () => {
    const { opportunityB, itemA } = await makeTwoOpportunities();
    await expect(deleteLineItem(opportunityB.id, itemA.id)).rejects.toThrow();

    const stillThere = await db.lineItem.findUnique({ where: { id: itemA.id } });
    expect(stillThere).not.toBeNull();
  });

  it("confirmDraftLineItem rejects a lineItemId that belongs to a different opportunity", async () => {
    const { opportunityB, itemA } = await makeTwoOpportunities();
    await expect(confirmDraftLineItem(opportunityB.id, itemA.id)).rejects.toThrow();
  });

  it("moveSectionOrder rejects a sectionId that belongs to a different opportunity", async () => {
    const { opportunityB, sectionA } = await makeTwoOpportunities();
    await expect(moveSectionOrder(opportunityB.id, sectionA.id, "up")).rejects.toThrow();
  });
});

describe("updateSectionDescription / clearSectionPendingDescription", () => {
  it("updateSectionDescription sets description and clears any pendingDescription", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Custom Build", sectionType: "COMPONENT" });
    await db.estimateSection.update({ where: { id: section.id }, data: { pendingDescription: "AI suggestion" } });

    await updateSectionDescription(section.id, "Reception counter");

    const updated = await db.estimateSection.findUniqueOrThrow({ where: { id: section.id } });
    expect(updated.description).toBe("Reception counter");
    expect(updated.pendingDescription).toBeNull();
  });

  it("clearSectionPendingDescription clears only pendingDescription, leaving description untouched", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Custom Build", sectionType: "COMPONENT" });
    await db.estimateSection.update({
      where: { id: section.id },
      data: { description: "Approved title", pendingDescription: "A new suggestion" },
    });

    await clearSectionPendingDescription(section.id);

    const updated = await db.estimateSection.findUniqueOrThrow({ where: { id: section.id } });
    expect(updated.description).toBe("Approved title");
    expect(updated.pendingDescription).toBeNull();
  });

  it("rejects both mutations on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "Custom Build", sectionType: "COMPONENT" });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 1, unitCost: 20 });
    await lockEstimateVersion(version.id);

    await expect(updateSectionDescription(section.id, "Reception counter")).rejects.toThrow();
    await expect(clearSectionPendingDescription(section.id)).rejects.toThrow();
  });
});

describe("updateBoothDescription / clearBoothPendingDescription", () => {
  it("updateBoothDescription sets boothDescription and clears boothPendingDescription on every section sharing the groupLabel", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const groupLabel = "SECTION 211";
    const sectionA = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    const sectionB = await addSection(version.id, { name: "Wall Panels", sectionType: "COMPONENT", groupLabel });
    await db.estimateSection.updateMany({ where: { estimateVersionId: version.id, groupLabel }, data: { boothPendingDescription: "AI suggestion" } });

    await updateBoothDescription(version.id, groupLabel, "Acme Corp booth");

    const [updatedA, updatedB] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionB.id } }),
    ]);
    expect(updatedA.boothDescription).toBe("Acme Corp booth");
    expect(updatedA.boothPendingDescription).toBeNull();
    expect(updatedB.boothDescription).toBe("Acme Corp booth");
    expect(updatedB.boothPendingDescription).toBeNull();
  });

  it("clearBoothPendingDescription clears only boothPendingDescription across every section sharing the groupLabel", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const groupLabel = "SECTION 211";
    const sectionA = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    const sectionB = await addSection(version.id, { name: "Wall Panels", sectionType: "COMPONENT", groupLabel });
    await db.estimateSection.updateMany({
      where: { estimateVersionId: version.id, groupLabel },
      data: { boothDescription: "Approved title", boothPendingDescription: "A new suggestion" },
    });

    await clearBoothPendingDescription(version.id, groupLabel);

    const [updatedA, updatedB] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionB.id } }),
    ]);
    expect(updatedA.boothDescription).toBe("Approved title");
    expect(updatedA.boothPendingDescription).toBeNull();
    expect(updatedB.boothDescription).toBe("Approved title");
    expect(updatedB.boothPendingDescription).toBeNull();
  });

  it("rejects both mutations on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const groupLabel = "SECTION 211";
    const section = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", qty: 1, unitCost: 20 });
    await lockEstimateVersion(version.id);

    await expect(updateBoothDescription(version.id, groupLabel, "Acme Corp booth")).rejects.toThrow();
    await expect(clearBoothPendingDescription(version.id, groupLabel)).rejects.toThrow();
  });
});

describe("updateSectionProposalVisibility", () => {
  it("sets includeInProposal across every section sharing the groupLabel, both directions", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const groupLabel = "SECTION 211";
    const sectionA = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    const sectionB = await addSection(version.id, { name: "Wall Panels", sectionType: "COMPONENT", groupLabel });

    await updateSectionProposalVisibility(version.id, groupLabel, false);
    const [hiddenA, hiddenB] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionB.id } }),
    ]);
    expect(hiddenA.includeInProposal).toBe(false);
    expect(hiddenB.includeInProposal).toBe(false);

    await updateSectionProposalVisibility(version.id, groupLabel, true);
    const [shownA, shownB] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionB.id } }),
    ]);
    expect(shownA.includeInProposal).toBe(true);
    expect(shownB.includeInProposal).toBe(true);
  });

  it("rejects on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const groupLabel = "SECTION 211";
    const section = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", qty: 1, unitCost: 20 });
    await lockEstimateVersion(version.id);

    await expect(updateSectionProposalVisibility(version.id, groupLabel, false)).rejects.toThrow();
  });
});

describe("moveSectionProposalOrder", () => {
  async function makeTaggedBooth(versionId: string, groupLabel: string, categoryName: string) {
    const section = await addSection(versionId, { name: "Labor", sectionType: "COMPONENT", groupLabel });
    await db.estimateSection.update({ where: { id: section.id }, data: { buildType: "RENTAL" } });
    await addLineItem(versionId, section.id, {
      lineType: "LABOR",
      description: `${groupLabel} labor`,
      category: categoryName,
      qty: 1,
      unitCost: 100,
    });
    return section;
  }

  it("moves a booth up/down among only the booths visible in one category, leaving proposalSortOrder untouched for the rest", async () => {
    await makeCategory("Labor", "labor");
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const boothA = await makeTaggedBooth(version.id, "Booth A", "Labor");
    const boothB = await makeTaggedBooth(version.id, "Booth B", "Labor");
    const boothC = await makeTaggedBooth(version.id, "Booth C", "Labor");

    // Starting order is alphabetical (every proposalSortOrder defaults to
    // 0, so the tiebreak applies): A, B, C.
    await moveSectionProposalOrder(version.id, "Booth C", "Labor", "up");

    const [updatedA, updatedB, updatedC] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: boothA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: boothB.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: boothC.id } }),
    ]);
    // C swapped with B (its immediate neighbor); A, first in line, is
    // untouched by a swap between the other two.
    expect(updatedA.proposalSortOrder).toBe(0);
    expect(updatedB.proposalSortOrder).toBe(2);
    expect(updatedC.proposalSortOrder).toBe(1);
  });

  it("does nothing when asked to move the first booth up or the last booth down", async () => {
    await makeCategory("Labor", "labor");
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const boothA = await makeTaggedBooth(version.id, "Booth A", "Labor");
    const boothB = await makeTaggedBooth(version.id, "Booth B", "Labor");

    await moveSectionProposalOrder(version.id, "Booth A", "Labor", "up");
    await moveSectionProposalOrder(version.id, "Booth B", "Labor", "down");

    const [updatedA, updatedB] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: boothA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: boothB.id } }),
    ]);
    expect(updatedA.proposalSortOrder).toBe(0);
    expect(updatedB.proposalSortOrder).toBe(0);
  });

  it("rejects on a locked version", async () => {
    await makeCategory("Labor", "labor");
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    await makeTaggedBooth(version.id, "Booth A", "Labor");
    await makeTaggedBooth(version.id, "Booth B", "Labor");
    await lockEstimateVersion(version.id);

    await expect(moveSectionProposalOrder(version.id, "Booth A", "Labor", "down")).rejects.toThrow();
  });
});

describe("moveElementGroupOrder", () => {
  async function makeBoothWithGroups(groupNames: string[]) {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const sections = [];
    for (const name of groupNames) {
      const section = await addSection(version.id, {
        name,
        sectionType: "COMPONENT",
        groupLabel: "Section 231 - Booth",
        buildType: "RENTAL",
      });
      await addLineItem(version.id, section.id, {
        lineType: "MATERIAL",
        description: `${name} item`,
        qty: 1,
        unitCost: 10,
      });
      sections.push(section);
    }
    return { version, sections };
  }

  it("moves a booth's own custom-named group up/down among its siblings, leaving the booth's identity untouched", async () => {
    const { version, sections } = await makeBoothWithGroups(["Booth Build", "Platform", "Extra"]);

    // Starting order is creation order (every sortOrder defaults to 0, so
    // there's no explicit ordering yet to override it): Booth Build,
    // Platform, Extra.
    await moveElementGroupOrder(version.id, "Section 231 - Booth", "Platform", "up");

    const updated = await Promise.all(sections.map((s) => db.estimateSection.findUniqueOrThrow({ where: { id: s.id } })));
    const byName = new Map(updated.map((s) => [s.name, s.sortOrder]));
    // Platform swapped with its immediate neighbor (Booth Build); Extra,
    // last in line, is untouched by a swap between the other two.
    expect(byName.get("Platform")).toBe(0);
    expect(byName.get("Booth Build")).toBe(1);
    expect(byName.get("Extra")).toBe(2);
  });

  it("does nothing when asked to move the first group up or the last group down", async () => {
    const { version, sections } = await makeBoothWithGroups(["Booth Build", "Platform"]);

    await moveElementGroupOrder(version.id, "Section 231 - Booth", "Booth Build", "up");
    await moveElementGroupOrder(version.id, "Section 231 - Booth", "Platform", "down");

    const updated = await Promise.all(sections.map((s) => db.estimateSection.findUniqueOrThrow({ where: { id: s.id } })));
    expect(updated.every((s) => s.sortOrder === 0)).toBe(true);
  });

  it("reorders a mapped group too -- its fixed build-sequence position is only a default, not a hard rule", async () => {
    // "BeMatrix" resolves through ELEMENT_TYPE_MAP to the fixed "Wall
    // Structure" label. Confirmed live as a real, wanted case: a
    // manually-built component wants its own custom groups ordered
    // above a fixed-label one like "Shipping," not the generic
    // frame-then-covering-then-shipping sequence that rank was designed
    // around for a different (BeMatrix/Wall Panels style) import shape.
    // Starting order is the fixed rank (Wall Structure before the
    // unmapped "Platform", both still at the shared 0 default).
    const { version, sections } = await makeBoothWithGroups(["BeMatrix", "Platform"]);
    const [beMatrix, platform] = sections;

    await moveElementGroupOrder(version.id, "Section 231 - Booth", "Wall Structure", "down");

    const [updatedBeMatrix, updatedPlatform] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: beMatrix.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: platform.id } }),
    ]);
    expect(updatedBeMatrix.sortOrder).toBe(1);
    expect(updatedPlatform.sortOrder).toBe(0);
  });

  it("rejects reordering on a locked version", async () => {
    const { version } = await makeBoothWithGroups(["Booth Build", "Platform"]);
    await lockEstimateVersion(version.id);

    await expect(moveElementGroupOrder(version.id, "Section 231 - Booth", "Platform", "up")).rejects.toThrow(/locked/);
  });

  it("still moves a merged (two-same-named-sections) unmapped group -- merging isn't a mapped category", async () => {
    // Regression companion to proposal-view-model.test.ts's own -- two
    // sections sharing the name "Custom Build" merge into one elementType
    // bucket the moment they both carry items, and that used to force
    // isMapped true, silently excluding the whole component from
    // moveElementGroupOrder's own movable list with no indication why.
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const customA = await addSection(version.id, {
      name: "Custom Build",
      sectionType: "COMPONENT",
      groupLabel: "Section 231 - Booth",
      buildType: "RENTAL",
    });
    const customB = await addSection(version.id, {
      name: "Custom Build",
      sectionType: "COMPONENT",
      groupLabel: "Section 231 - Booth",
      buildType: "RENTAL",
    });
    const platform = await addSection(version.id, {
      name: "Platform",
      sectionType: "COMPONENT",
      groupLabel: "Section 231 - Booth",
      buildType: "RENTAL",
    });
    for (const section of [customA, customB, platform]) {
      await addLineItem(version.id, section.id, {
        lineType: "MATERIAL",
        description: `${section.name} item`,
        qty: 1,
        unitCost: 10,
      });
    }

    await moveElementGroupOrder(version.id, "Section 231 - Booth", "Custom Build", "down");

    const [updatedA, updatedB, updatedPlatform] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: customA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: customB.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: platform.id } }),
    ]);
    // The merged group moves as one unit -- both of its own sections land
    // on the SAME new sortOrder, swapped with Platform's.
    expect(updatedA.sortOrder).toBe(1);
    expect(updatedB.sortOrder).toBe(1);
    expect(updatedPlatform.sortOrder).toBe(0);
  });
});
