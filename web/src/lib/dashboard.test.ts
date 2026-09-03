import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getDashboardData } from "@/lib/dashboard";
import { addLineItem, addSection, createEstimateVersion, updateSectionExcludedFromTotals } from "@/lib/estimate-service";

// Admin bypasses opportunity-scoping entirely (see opportunity-access.ts) --
// these tests exercise the key-dates/dedup logic, not access control, so an
// admin viewer keeps every fixture opportunity visible.
const ADMIN_USER = { id: "test-admin", systemRole: "ADMIN" } as const;

afterEach(async () => {
  await db.lineItemAuditLog.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.workOrder.deleteMany();
  await db.project.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity(showName: string, ownerId: string | null = null) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName, ownerId } });
}

// Full graph (Estimate -> EstimateVersion -> EstimateSection -> LineItem)
// with one booth flagged excludedFromTotals -- reuses the real service
// functions (estimate-service.ts) rather than hand-building rows, same
// discipline as estimate-service.test.ts's own fixtures.
async function makeFlaggedOpportunity(showName: string, ownerId: string | null, cost: number) {
  const opportunity = await makeOpportunity(showName, ownerId);
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  const groupLabel = "Bid Comparison";
  const section = await addSection(version.id, { name: "Labor", sectionType: "COMPONENT", groupLabel });
  await addLineItem(version.id, section.id, {
    lineType: "LABOR",
    description: "Straight Time Rate in Chicago - CSI",
    qty: 1,
    unitCost: cost,
  });
  await updateSectionExcludedFromTotals(version.id, groupLabel, true);
  return { opportunity, estimateId: estimate.id, groupLabel };
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function makeAnalyzedDocument(opportunityId: string, filename: string, keyDates: unknown[]) {
  return db.document.create({
    data: {
      opportunityId,
      filename,
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: `key-${filename}`,
      documentType: "RFP",
      extractionStatus: "COMPLETE",
      extractedSummary: {
        eventOrProjectName: null,
        venue: null,
        submissionDeadline: null,
        keyDates,
        scopeSummary: [],
        riskFlags: [],
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

describe("getDashboardData -- RFP key dates", () => {
  it("collapses the same fact restated in two documents into one dashboard entry", async () => {
    const opportunity = await makeOpportunity("Super Bowl 2026");
    const date = isoDaysFromNow(10);
    const keyDate = {
      label: "Bidder Questions Due",
      date,
      dateType: "DEADLINE",
      sourceQuote: "x",
      pageNumber: null,
    };
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [keyDate]);
    await makeAnalyzedDocument(opportunity.id, "Appendix A.pdf", [keyDate]);

    const { upcomingDeadlines } = await getDashboardData(ADMIN_USER);
    const matches = upcomingDeadlines.filter((d) => d.label.startsWith("Bidder Questions Due"));
    expect(matches).toHaveLength(1);
  });

  it("keeps two genuinely different facts (different labels) from the same opportunity separate", async () => {
    const opportunity = await makeOpportunity("Super Bowl 2026");
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "Bidder Questions Due", date: isoDaysFromNow(10), dateType: "DEADLINE", sourceQuote: "x", pageNumber: null },
      { label: "Tender Submission Due", date: isoDaysFromNow(20), dateType: "DEADLINE", sourceQuote: "x", pageNumber: null },
    ]);

    const { upcomingDeadlines } = await getDashboardData(ADMIN_USER);
    expect(upcomingDeadlines).toHaveLength(2);
  });

  it("excludes a date so far in the past it can no longer be a real 'upcoming' deadline -- the stale/misread-year case", async () => {
    const opportunity = await makeOpportunity("Super Bowl 2026");
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      {
        label: "Start of Installation",
        date: isoDaysFromNow(-400), // over a year stale -- e.g. a misread 2026 vs 2027
        dateType: "MILESTONE",
        sourceQuote: "x",
        pageNumber: null,
      },
    ]);

    const { upcomingDeadlines } = await getDashboardData(ADMIN_USER);
    expect(upcomingDeadlines).toHaveLength(0);
  });

  it("still shows a deadline that's only recently overdue, marked overdue", async () => {
    const opportunity = await makeOpportunity("Super Bowl 2026");
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "Bidder Questions Due", date: isoDaysFromNow(-5), dateType: "DEADLINE", sourceQuote: "x", pageNumber: null },
    ]);

    const { upcomingDeadlines } = await getDashboardData(ADMIN_USER);
    expect(upcomingDeadlines).toHaveLength(1);
    expect(upcomingDeadlines[0].overdue).toBe(true);
  });

  it("excludes an INFORMATIONAL fact entirely, even when two documents restate it", async () => {
    const opportunity = await makeOpportunity("Super Bowl 2026");
    const keyDate = {
      label: "RFP Sent",
      date: isoDaysFromNow(-2),
      dateType: "INFORMATIONAL",
      sourceQuote: "x",
      pageNumber: null,
    };
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [keyDate]);
    await makeAnalyzedDocument(opportunity.id, "Appendix A.pdf", [keyDate]);

    const { upcomingDeadlines } = await getDashboardData(ADMIN_USER);
    expect(upcomingDeadlines).toHaveLength(0);
  });
});

describe("getDashboardData -- flagged for review (excludedFromTotals)", () => {
  it("surfaces a flagged booth as its own dashboard item, with a link into that estimate's Review tab", async () => {
    const { estimateId, groupLabel } = await makeFlaggedOpportunity("Full Swing Chicago", null, 100);

    const { flaggedForReview } = await getDashboardData(ADMIN_USER);

    expect(flaggedForReview).toHaveLength(1);
    expect(flaggedForReview[0]).toMatchObject({
      estimateId,
      groupLabel,
      cost: 100,
      href: `/estimates/${estimateId}?tab=review#excluded-bid-comparison`,
    });
  });

  it("an admin sees a flagged item regardless of who owns the opportunity", async () => {
    const owner = await db.user.create({ data: { email: "owner@test.com", name: "Owner", systemRole: "EMPLOYEE" } });
    await makeFlaggedOpportunity("Someone Else's Show", owner.id, 100);

    const { flaggedForReview } = await getDashboardData(ADMIN_USER);
    expect(flaggedForReview).toHaveLength(1);
  });

  it("a non-admin employee never sees a flagged item from an opportunity they don't own or collaborate on", async () => {
    const owner = await db.user.create({ data: { email: "owner@test.com", name: "Owner", systemRole: "EMPLOYEE" } });
    const viewer = await db.user.create({ data: { email: "viewer@test.com", name: "Viewer", systemRole: "EMPLOYEE" } });
    await makeFlaggedOpportunity("Someone Else's Show", owner.id, 100);

    const { flaggedForReview } = await getDashboardData({ id: viewer.id, systemRole: "EMPLOYEE" });
    expect(flaggedForReview).toHaveLength(0);
  });

  it("a non-admin employee sees a flagged item from their own opportunity", async () => {
    const owner = await db.user.create({ data: { email: "owner@test.com", name: "Owner", systemRole: "EMPLOYEE" } });
    const { groupLabel } = await makeFlaggedOpportunity("My Own Show", owner.id, 100);

    const { flaggedForReview } = await getDashboardData({ id: owner.id, systemRole: "EMPLOYEE" });
    expect(flaggedForReview).toHaveLength(1);
    expect(flaggedForReview[0].groupLabel).toBe(groupLabel);
  });
});
