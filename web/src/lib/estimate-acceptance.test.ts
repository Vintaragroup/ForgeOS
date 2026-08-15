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
import { approveEstimateVersion, generateProposal, sendProposal, signProposal } from "@/lib/proposal-service";
import { computeChangeOrderDiff, createChangeOrder } from "@/lib/change-order-service";
import { computeDepartmentVariance, computeLineItemVariance, recordCostActual } from "@/lib/cost-actual-service";

afterEach(async () => {
  await db.costActual.deleteMany();
  await db.proposal.deleteMany();
  await db.proposalTemplate.deleteMany();
  await db.changeOrder.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
  await db.category.deleteMany();
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
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Line 1", qty: 1, unitCost: 900 });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Line 2", qty: 1, unitCost: 900 });

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
    await addLineItem(version.id, section.id, {
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

// Phase 4: proposal/approval and ChangeOrder machinery, proven against
// the same real Yoku Moku total Phase 3 already validated above -- shows
// the new workflow doesn't corrupt or diverge from an already-verified
// real number, and that a change order's diff reflects real dollar
// amounts, not just synthetic ones.
describe("Yoku Moku through the Phase 4 workflow", () => {
  async function makeLockedYokuMokuVersion() {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 45.3996887538702);
    const section = await addSection(version.id, { name: "COST SUMMARY", sectionType: "CATEGORY" });
    // sendProposal (proposal-service.ts) hard-blocks on an unresolved
    // category (see category-audit.ts), so this fixture needs a real,
    // matching Category row -- forgeos_test has no seeded categories.
    const category = await db.category.create({ data: { name: "Professional Services", key: "professional_services" } });
    await addLineItem(version.id, section.id, {
      lineType: "FEE",
      description: "Total job cost (Phase 1 validated)",
      qty: 1,
      unitCost: 36060.684,
      category: category.name,
    });
    const locked = await lockEstimateVersion(version.id);
    return { estimate, version: locked };
  }

  it("carries the real total unchanged through approve -> generate -> send -> sign", async () => {
    const { version } = await makeLockedYokuMokuVersion();
    const user = await db.user.create({ data: { name: "Approver", email: `a-${Date.now()}@example.com` } });
    const template = await db.proposalTemplate.create({ data: { name: "Standard" } });

    await approveEstimateVersion(version.id, user.id);
    const proposal = await generateProposal(version.id, template.id);
    const sent = await sendProposal(proposal.id);
    const signed = await signProposal(proposal.id, "Jane Doe");

    expect(signed.signedAt).not.toBeNull();
    expect(sent.sentAt).not.toBeNull();

    // the proposal's estimateVersion is exactly the one Phase 3 validated
    // -- generating/sending/signing never touches EstimateVersion's totals
    const reloadedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(reloadedVersion.grandTotal.toNumber()).toBeCloseTo(66045.2, 2);
  });

  it("a change order against the real Yoku Moku total produces a correctly-priced real-dollar diff", async () => {
    const { estimate, version } = await makeLockedYokuMokuVersion();
    const user = await db.user.create({ data: { name: "Approver", email: `a-${Date.now()}@example.com` } });
    await approveEstimateVersion(version.id, user.id);

    // Real Booksy-scale add-on: Phase 1's second validated job (Booksy,
    // $58,311.18) -- used here only as a realistic magnitude for a
    // "add a second job's worth of scope" change order, not claiming
    // Booksy was literally a change order against Yoku Moku.
    const changeOrder = await createChangeOrder(estimate.id, version.id, "Add Booksy-scale second phase");
    const resultSection = await db.estimateSection.findFirstOrThrow({
      where: { estimateVersionId: changeOrder.resultVersionId },
    });
    await addLineItem(changeOrder.resultVersionId, resultSection.id, {
      lineType: "FEE",
      description: "Second phase scope",
      qty: 1,
      unitCost: 58311.18,
    });
    await lockEstimateVersion(changeOrder.resultVersionId);

    const base = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    const result = await db.estimateSection.findMany({
      where: { estimateVersionId: changeOrder.resultVersionId },
      include: { lineItems: true },
    });
    const diff = computeChangeOrderDiff(base, result);

    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ kind: "ADDED", description: "Second phase scope" });
    expect(diff[0].delta.toNumber()).toBeCloseTo(58311.18, 2);
  });
});

// Phase 6: actual-cost capture and variance reporting, proven against the
// real Yoku Moku estimated cost Phase 3 already validated. The actual
// cost itself is a plausible synthetic figure (no real actuals were ever
// captured for this job, since ForgeOS didn't exist yet) -- schema.prisma's
// Phase 6 comment already explains why the AI-assisted features stay
// deferred rather than built against synthetic history; this test only
// proves the variance *math* is correct against a real baseline, not that
// the specific actual figure is historically true.
describe("Yoku Moku through the Phase 6 workflow", () => {
  it("computes correct variance for a real estimated cost against a recorded actual", async () => {
    const estimate = await makeEstimate();
    const version = await createEstimateVersion(estimate.id, 45.3996887538702);
    const section = await addSection(version.id, { name: "COST SUMMARY", sectionType: "CATEGORY" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "FEE",
      description: "Total job cost (Phase 1 validated)",
      department: "EF",
      qty: 1,
      unitCost: 36060.684,
    });
    await lockEstimateVersion(version.id);

    // Synthetic actual: came in $2,000 over the real estimated cost.
    await recordCostActual({ opportunityId: estimate.opportunityId, lineItemId: lineItem.id, actualCost: 38060.68, source: "Acceptance test" });

    const reloaded = await db.lineItem.findUniqueOrThrow({
      where: { id: lineItem.id },
      include: { costActuals: true },
    });
    const [variance] = computeLineItemVariance([reloaded]);

    expect(variance.estimatedCost.toNumber()).toBeCloseTo(36060.68, 2);
    expect(variance.actualCost.toNumber()).toBeCloseTo(38060.68, 2);
    expect(variance.variance.toNumber()).toBeCloseTo(2000, 2); // over budget

    const [byDept] = computeDepartmentVariance([variance]);
    expect(byDept.department).toBe("EF");
    expect(byDept.variance.toNumber()).toBeCloseTo(2000, 2);
  });
});
