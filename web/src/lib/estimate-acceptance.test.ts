// Acceptance tests against real, historical job data recalculated during
// Phase 1 (docs/phase1-findings.md) -- per docs/migration-plan.md's Phase 3
// exit criteria, "using Phase 1's comparison harness as the acceptance
// test." Unlike estimate-service.test.ts's unit tests (synthetic numbers,
// exercising formula shape), these prove the *whole pipeline* --
// createEstimateVersion -> addSection -> addLineItem ->
// recomputeVersionTotals/lockEstimateVersion, all through the real
// Postgres-backed service, not just the pure compute functions -- lands on
// numbers independently verified against a real client's actual workbook.
//
// Job: Yoku Moku (Phase 1, matched to the penny against the real sent
// proposal). Source values were recovered from that job's recalculated
// workbook during Phase 1 and are not re-derivable from any committed
// file here (the source .xlsm and historical job data are gitignored --
// see docs/migration-plan.md's PII/data-handling notes).

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addLineItem,
  addSection,
  computeSectionTotal,
  createEstimateVersion,
  lockEstimateVersion,
} from "@/lib/estimate-service";

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeEstimate() {
  const company = await db.company.create({ data: { name: "Acceptance Test Co" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Acceptance Test Show" },
  });
  return db.estimate.create({ data: { opportunityId: opportunity.id } });
}

describe("Yoku Moku acceptance (Phase 1 validated)", () => {
  it("rolls up COMPONENT 2's two real line items to the real $1,800 section total", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 2", sectionType: "COMPONENT" });

    // Two real line items from Yoku Moku's COMPONENT 2 sheet: qty=1,
    // unitCost=900 each (business-rules.md Rule 2: material qty x cost).
    await addLineItem(section.id, { lineType: "MATERIAL", description: "Line 1", qty: 1, unitCost: 900 });
    await addLineItem(section.id, { lineType: "MATERIAL", description: "Line 2", qty: 1, unitCost: 900 });

    const lineItems = await db.lineItem.findMany({ where: { sectionId: section.id } });
    const sectionTotal = computeSectionTotal(lineItems);

    expect(sectionTotal.toNumber()).toBe(1800);
  });

  it("reproduces Yoku Moku's real grand total through the full DB-backed pipeline, within schema precision", async () => {
    const estimate = await makeEstimate();
    // cost=36060.684, margin=45.3996887538702 -- independently recovered
    // from Yoku Moku's real recalculated workbook during Phase 1.
    // computeMarginGrossUp(cost, margin) reproduces the real sent
    // proposal's $66,044.83 EXACTLY at full precision (see
    // estimate-service.test.ts). Here, marginTargetPct is a
    // Decimal(5,2) column (business-rules.md Rule 6: it's a
    // user-editable percentage an estimator types in, e.g. "45.40") and
    // unitCost/totalCost are Decimal(10,2)/(12,2) -- both round on
    // write, so the full-precision inputs above land as 45.40 / 36060.68
    // once stored. That ~$0.37 delta from $66,044.83 is expected
    // 2-decimal-place rounding, not a formula defect -- the formula
    // itself is already proven exact.
    const version = await createEstimateVersion(estimate.id, 45.3996887538702);
    const section = await addSection(version.id, { name: "COST SUMMARY", sectionType: "CATEGORY" });
    await addLineItem(section.id, {
      lineType: "FEE",
      description: "Total job cost (Phase 1 validated)",
      qty: 1,
      unitCost: 36060.684,
    });

    const locked = await lockEstimateVersion(version.id);

    expect(locked.totalCost.toNumber()).toBeCloseTo(36060.68, 2);
    expect(locked.grandTotal.toNumber()).toBeCloseTo(66045.2, 2);
    // still within 1% of the workbook's real total -- confirms the
    // pipeline, not just the formula, is wired correctly end to end.
    expect(locked.grandTotal.toNumber()).toBeCloseTo(66044.83, -2);
    expect(locked.isLocked).toBe(true);
  });
});
