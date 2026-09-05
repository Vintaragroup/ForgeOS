import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getProposalCoverInfo } from "@/lib/proposal-timeline";
import { updateTimelineMilestone } from "@/lib/timeline-service";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return { company, opportunity };
}

describe("getProposalCoverInfo", () => {
  it("returns an empty timeline when no Timeline has ever been generated/edited", async () => {
    const { opportunity } = await makeOpportunity();
    const info = await getProposalCoverInfo(opportunity.id);
    expect(info.timeline).toEqual([]);
  });

  it("only includes milestones with a real date, sourced from Opportunity.timelineMilestones, sorted chronologically", async () => {
    const { opportunity } = await makeOpportunity();
    await updateTimelineMilestone(opportunity.id, "BALANCE_DUE", { date: new Date("2026-12-30"), responsibleParty: "CLIENT" });
    await updateTimelineMilestone(opportunity.id, "DEPOSIT_DUE", { date: new Date("2026-09-23"), responsibleParty: "CLIENT" });
    await updateTimelineMilestone(opportunity.id, "SHIPPING", { date: new Date("2027-01-04"), responsibleParty: "EXPO_CC" });

    const info = await getProposalCoverInfo(opportunity.id);

    expect(info.timeline.map((t) => t.label)).toEqual(["Deposit due", "Balance due", "Shipping to show site"]);
    expect(info.timeline[0].date).toEqual(new Date("2026-09-23"));
    expect(info.timeline[2].responsibleParty).toBe("EXPO_CC");
  });

  it("excludes a milestone whose date is still null, even though the row exists", async () => {
    const { opportunity } = await makeOpportunity();
    await updateTimelineMilestone(opportunity.id, "DEPOSIT_DUE", { date: new Date("2026-09-23"), responsibleParty: "CLIENT" });

    const info = await getProposalCoverInfo(opportunity.id);

    // 10 of the 11 canonical rows are still null (never populated) -- only
    // the one with a real date makes it onto the client-facing timeline.
    expect(info.timeline).toHaveLength(1);
    expect(info.timeline[0].label).toBe("Deposit due");
  });

  it("still sources venue/scopeSummary from analyzed documents, unaffected by the timeline change", async () => {
    const { opportunity } = await makeOpportunity();
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "RFP.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
        extractedSummary: {
          eventOrProjectName: null,
          venue: "Mandalay Bay Convention Center",
          submissionDeadline: null,
          keyDates: [],
          scopeSummary: [{ text: "20x20 island exhibit", sourceQuote: "20x20 island", pageNumber: null }],
          riskFlags: [],
        },
      },
    });

    const info = await getProposalCoverInfo(opportunity.id);
    expect(info.venue).toBe("Mandalay Bay Convention Center");
    expect(info.scopeSummary).toEqual(["20x20 island exhibit"]);
  });
});
