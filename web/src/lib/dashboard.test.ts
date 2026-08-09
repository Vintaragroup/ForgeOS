import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getDashboardData } from "@/lib/dashboard";

// Admin bypasses opportunity-scoping entirely (see opportunity-access.ts) --
// these tests exercise the key-dates/dedup logic, not access control, so an
// admin viewer keeps every fixture opportunity visible.
const ADMIN_USER = { id: "test-admin", systemRole: "ADMIN" } as const;

afterEach(async () => {
  await db.document.deleteMany();
  await db.workOrder.deleteMany();
  await db.project.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity(showName: string) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName } });
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
