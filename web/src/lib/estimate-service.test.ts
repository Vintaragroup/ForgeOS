import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import {
  addAttachment,
  addLineItem,
  addOption,
  addSection,
  computeLineItemTotal,
  computeMarginGrossUp,
  computeOptionTotal,
  computeSectionTotal,
  computeVersionTotals,
  confirmDraftLineItem,
  createEstimateVersion,
  createNewVersionFromLocked,
  deleteLineItem,
  lockEstimateVersion,
  recomputeVersionTotals,
  updateLineItem,
  updateMarginTarget,
} from "@/lib/estimate-service";

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.attachment.deleteMany();
  await db.estimateSection.deleteMany();
  await db.option.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

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
        { lineItems: [{ totalCost: 100 }, { totalCost: 200 }] },
        { lineItems: [{ totalCost: 300 }] },
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
});

describe("estimate version lifecycle", () => {
  it("builds sections/line items and locks a version with computed totals", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);

    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });
    await addLineItem(section.id, {
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
      addLineItem(section.id, { lineType: "MATERIAL", description: "Late add", qty: 1, unitCost: 1 }),
    ).rejects.toThrow(/locked/);
  });

  it("recomputes totals live as line items change, without locking", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });

    let refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(200);
    expect(refreshed.isLocked).toBe(false);

    await updateLineItem(lineItem.id, { qty: 15 });
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
    await addLineItem(section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
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
    await addLineItem(v2Sections[0].id, { lineType: "MATERIAL", description: "Extra", qty: 1, unitCost: 5 });
  });

  it("carries over the source version's totals so the copy isn't shown as $0 before its first edit", async () => {
    const estimate = await makeEstimate();
    const v1 = await createEstimateVersion(estimate.id, 50);
    const section = await addSection(v1.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
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
    await addLineItem(section.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });
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
    const lineItem = await addLineItem(section.id, {
      lineType: "MATERIAL",
      description: "Plywood",
      qty: 10,
      unitCost: 20,
    });

    const deleted = await deleteLineItem(lineItem.id);
    expect(deleted.estimateVersionId).toBe(version.id);

    const refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(0);
  });
});

describe("Option (alternates)", () => {
  it("an Option's sections are priced separately from the base estimate total", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 50);
    const baseSection = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    await addLineItem(baseSection.id, { lineType: "MATERIAL", description: "Plywood", qty: 10, unitCost: 20 });

    const option = await addOption(version.id, { name: "Option 1: Upgraded flooring" });
    const optionSection = await addSection(version.id, {
      name: "COMPONENT 1 (Option 1)",
      sectionType: "COMPONENT",
      optionId: option.id,
    });
    await addLineItem(optionSection.id, {
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
    await addLineItem(optionSection.id, {
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

describe("design-intake prototype: draft line items + Attachment", () => {
  it("excludes draft line items from section/version totals until confirmed", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const attachment = await addAttachment(estimate.id, { fileRef: "pull-sheet-v1.pdf" });

    await addLineItem(section.id, { lineType: "MATERIAL", description: "Confirmed line", qty: 1, unitCost: 100 });
    const draft = await addLineItem(section.id, {
      lineType: "MATERIAL",
      description: "Drafted from pull sheet",
      qty: 1,
      unitCost: 900,
      isDraft: true,
      attachmentId: attachment.id,
    });

    let refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(100); // draft's $900 excluded

    await confirmDraftLineItem(draft.id);
    refreshed = await recomputeVersionTotals(version.id);
    expect(refreshed.totalCost.toNumber()).toBe(1000); // now counts
  });

  it("rejects confirming a draft on a locked version", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const draft = await addLineItem(section.id, {
      lineType: "MATERIAL",
      description: "Drafted",
      qty: 1,
      unitCost: 100,
      isDraft: true,
    });
    await lockEstimateVersion(version.id);

    await expect(confirmDraftLineItem(draft.id)).rejects.toThrow(/locked/);
  });
});
