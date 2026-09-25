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

// Full Swing's proposal opened with "Rental of LED screens and monitors
// for the event", straight out of the Fuse AV quote -- which was
// withdrawn when Fuse came off the job. A document that is no longer the
// authority for anything must not be writing the client's Project
// Description.
describe("getProposalCoverInfo -- document validity", () => {
  async function addDocument(
    opportunityId: string,
    filename: string,
    scope: string,
    over: { validity?: "CURRENT" | "WITHDRAWN"; supersedesId?: string; venue?: string } = {},
  ) {
    return db.document.create({
      data: {
        opportunityId,
        filename,
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: `k-${filename}`,
        documentType: "VENDOR_QUOTE",
        extractionStatus: "COMPLETE",
        validity: over.validity ?? "CURRENT",
        supersedesId: over.supersedesId,
        extractedSummary: {
          eventOrProjectName: null,
          venue: over.venue ?? null,
          submissionDeadline: null,
          keyDates: [],
          scopeSummary: [{ text: scope, sourceQuote: scope, pageNumber: null }],
          risks: [],
          candidateGaps: [],
        },
      },
    });
  }

  it("leaves a withdrawn document's scope off the proposal", async () => {
    const { opportunity } = await makeOpportunity();
    await addDocument(opportunity.id, "current.pdf", "Five 100-inch monitors, purchased");
    await addDocument(opportunity.id, "fuse.pdf", "Rental of LED screens and monitors for the event", {
      validity: "WITHDRAWN",
    });

    const { scopeSummary } = await getProposalCoverInfo(opportunity.id);
    expect(scopeSummary).toEqual(["Five 100-inch monitors, purchased"]);
  });

  // Derived from the chain, the same way document-validity.ts derives it
  // everywhere else -- a document something else supersedes is stale
  // whatever its own column says.
  it("leaves a superseded document's scope off too", async () => {
    const { opportunity } = await makeOpportunity();
    const old = await addDocument(opportunity.id, "v1.pdf", "Two hanging banners");
    await addDocument(opportunity.id, "v2.pdf", "Three hanging banners", { supersedesId: old.id });

    const { scopeSummary } = await getProposalCoverInfo(opportunity.id);
    expect(scopeSummary).toEqual(["Three hanging banners"]);
  });

  it("still uses every document that is current", async () => {
    const { opportunity } = await makeOpportunity();
    await addDocument(opportunity.id, "a.pdf", "Hanging sign");
    await addDocument(opportunity.id, "b.pdf", "Reception counter");

    const { scopeSummary } = await getProposalCoverInfo(opportunity.id);
    expect(scopeSummary.sort()).toEqual(["Hanging sign", "Reception counter"]);
  });

  // It used to be whatever order the database returned, which is no way
  // to choose what a client reads.
  it("takes the venue from the newest current document", async () => {
    const { opportunity } = await makeOpportunity();
    await addDocument(opportunity.id, "older.pdf", "scope a", { venue: "Old Hall" });
    await new Promise((r) => setTimeout(r, 10));
    await addDocument(opportunity.id, "newer.pdf", "scope b", { venue: "New Hall" });

    const { venue } = await getProposalCoverInfo(opportunity.id);
    expect(venue).toBe("New Hall");
  });
});
