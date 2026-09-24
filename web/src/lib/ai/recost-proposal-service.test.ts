import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";

// The model is the only thing faked. Everything else -- the review it
// works from, the validation, the writes -- is the real path, because
// what this file is testing is precisely what happens to a model's
// answer between it arriving and a human seeing it.
const completions = vi.fn();

vi.mock("@/lib/ai/openai-client", () => ({
  ADVANCED_MODEL: "test-advanced",
  getOpenAiClient: () => ({ chat: { completions: { create: completions } } }),
}));

vi.mock("@/lib/ai/ai-usage-service", () => ({ recordAiUsage: async () => {} }));

const { proposeRecostChanges } = await import("@/lib/ai/recost-proposal-service");

const DRAWING_FINDING = {
  kind: "REMOVED" as const,
  subject: "front structure",
  detail: "The front structure with monitors and LED elements is no longer present.",
  previousPage: 5,
  revisedPage: null,
};

function respond(proposals: unknown[]) {
  completions.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ proposals }) } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

let versionId = "";
let sectionId = "";
let lineItemId = "";
let estimateId = "";
let sourceDocumentId = "";

beforeEach(async () => {
  const company = await db.company.create({ data: { name: "Full Swing" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "ABCA Chicago", stage: "ESTIMATING" },
  });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  estimateId = estimate.id;
  await db.estimateVersion.create({ data: { estimateId: estimate.id, versionNumber: 1, isLocked: true } });
  const version = await db.estimateVersion.create({
    data: { estimateId: estimate.id, versionNumber: 2, isLocked: false, totalCost: 1000, grandTotal: 1650 },
  });
  versionId = version.id;
  const section = await db.estimateSection.create({
    data: { estimateVersionId: version.id, name: "Front Structure", groupLabel: "FS", sectionType: "COMPONENT" },
  });
  sectionId = section.id;
  const lineItem = await db.lineItem.create({
    data: {
      sectionId: section.id,
      lineType: "MATERIAL",
      description: "Front structure monitor mounts",
      qty: 1,
      unitCost: 1000,
      totalCost: 1000,
    },
  });
  lineItemId = lineItem.id;

  const previous = await db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "PREVIOUS.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      storageKey: "k1",
      documentType: "DRAWING",
    },
  });
  const revised = await db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "REVISED.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      storageKey: "k2",
      documentType: "DRAWING",
      supersedesId: previous.id,
      revisionComparison: {
        previousDocumentId: previous.id,
        previousFilename: "PREVIOUS.pdf",
        revisedDocumentId: "unused",
        revisedFilename: "REVISED.pdf",
        findings: [DRAWING_FINDING],
        previousPagesCompared: 9,
        revisedPagesCompared: 9,
        charactersMismatched: false,
        previousCharacter: "DIMENSIONED",
        revisedCharacter: "DIMENSIONED",
        comparedAt: "2026-09-24T15:07:20.189Z",
      },
    },
  });
  sourceDocumentId = revised.id;
});

afterEach(async () => {
  completions.mockReset();
  await db.recostProposal.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("proposeRecostChanges", () => {
  it("writes a proposal that names a real row and quotes its source", async () => {
    respond([
      {
        findingId: "F1",
        action: "REMOVE",
        lineItemIds: [lineItemId],
        sectionId: null,
        reason: "These mounts price the structure the revised drawing no longer shows.",
        sourceQuote: "The front structure with monitors and LED elements is no longer present.",
        sourceLocation: "p5",
        confidence: "RECOMMEND_AND_CONFIRM",
        newUnitCost: null,
        newQty: null,
      },
    ]);

    const run = await proposeRecostChanges(estimateId, "user-1");
    expect(run.proposed).toBe(1);
    expect(run.rejected).toEqual([]);

    const rows = await db.recostProposal.findMany({ where: { estimateVersionId: versionId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].lineItemId).toBe(lineItemId);
    // The source is carried from the finding, not from the model.
    expect(rows[0].sourceDocumentId).toBe(sourceDocumentId);
    // Value engineering is the default, so a removal is never arrived at
    // already agreed however confident the model was.
    expect(rows[0].confidence).toBe("NEED_YOUR_DECISION");
    expect(rows[0].status).toBe("PROPOSED");
  });

  // The whole point of the gate: a fabricated citation writes nothing.
  it("writes nothing when the quote is not in the source", async () => {
    respond([
      {
        findingId: "F1",
        action: "REMOVE",
        lineItemIds: [lineItemId],
        reason: "The client asked for this to come out.",
        sourceQuote: "The client asked for the front structure to be removed to save $40,000.",
        confidence: "RECOMMEND_AND_CONFIRM",
      },
    ]);

    const run = await proposeRecostChanges(estimateId, "user-1");
    expect(run.proposed).toBe(0);
    expect(run.rejected[0].why).toMatch(/quote does not appear/);
    expect(await db.recostProposal.count()).toBe(0);
  });

  it("writes nothing when the model names an id this estimate does not have", async () => {
    respond([
      {
        findingId: "F1",
        action: "REMOVE",
        lineItemIds: ["li-invented"],
        sectionId: "sec-invented",
        reason: "Gone from the revised drawing.",
        sourceQuote: "The front structure with monitors and LED elements is no longer present.",
        confidence: "NEED_YOUR_DECISION",
      },
    ]);

    const run = await proposeRecostChanges(estimateId, "user-1");
    expect(run.proposed).toBe(0);
    expect(await db.recostProposal.count()).toBe(0);
  });

  it("stores a whole-booth proposal as one row against the section", async () => {
    respond([
      {
        findingId: "F1",
        action: "REMOVE",
        lineItemIds: [],
        sectionId,
        reason: "The whole element is gone from the revised drawing.",
        sourceQuote: "The front structure with monitors and LED elements is no longer present.",
        confidence: "NEED_YOUR_DECISION",
      },
    ]);

    await proposeRecostChanges(estimateId, "user-1");
    const rows = await db.recostProposal.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].sectionId).toBe(sectionId);
    expect(rows[0].lineItemId).toBeNull();
  });

  // The first production run put both structure removals against "Booth
  // Structure & Walls" -- 0 rows, $0. A proposal to remove nothing.
  it("never offers a section with no line items in it", async () => {
    const empty = await db.estimateSection.create({
      data: {
        estimateVersionId: versionId,
        name: "Booth Structure & Walls",
        sectionType: "CATEGORY",
      },
    });
    respond([
      {
        findingId: "F1",
        action: "REMOVE",
        lineItemIds: [],
        sectionId: empty.id,
        reason: "The structure is gone from the revised drawing.",
        sourceQuote: "The front structure with monitors and LED elements is no longer present.",
        confidence: "NEED_YOUR_DECISION",
      },
    ]);

    const run = await proposeRecostChanges(estimateId, "user-1");
    expect(run.proposed).toBe(0);
    expect(run.rejected[0].why).toMatch(/does not name a line item or section/);
    expect(await db.recostProposal.count()).toBe(0);
  });

  // A re-run is a re-read of the same documents. Two runs' worth of
  // proposals side by side is a list nobody can act on -- but a decision
  // a person already made is not a model's to overwrite.
  it("replaces undecided proposals on a re-run and leaves decided ones alone", async () => {
    const decided = await db.recostProposal.create({
      data: {
        estimateVersionId: versionId,
        lineItemId,
        action: "REMOVE",
        reason: "decided already",
        sourceDocumentId,
        sourceQuote: "q",
        confidence: "NEED_YOUR_DECISION",
        status: "ACCEPTED",
      },
    });
    await db.recostProposal.create({
      data: {
        estimateVersionId: versionId,
        lineItemId,
        action: "REMOVE",
        reason: "stale proposal from the last run",
        sourceDocumentId,
        sourceQuote: "q",
        confidence: "NEED_YOUR_DECISION",
        status: "PROPOSED",
      },
    });

    respond([
      {
        findingId: "F1",
        action: "NEEDS_QUOTE",
        lineItemIds: [lineItemId],
        reason: "Changed, and nobody has priced it.",
        sourceQuote: "The front structure with monitors and LED elements is no longer present.",
        confidence: "NEED_YOUR_DECISION",
      },
    ]);

    await proposeRecostChanges(estimateId, "user-1");

    const rows = await db.recostProposal.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === decided.id)?.status).toBe("ACCEPTED");
    expect(rows.find((r) => r.status === "PROPOSED")?.reason).toBe("Changed, and nobody has priced it.");
  });

  // No comparison means no findings, and no findings means no reason to
  // spend a model call. The button is opt-in but the run still has to
  // decide it has something to do.
  it("does not call the model when there is nothing to map", async () => {
    await db.document.updateMany({ data: { revisionComparison: undefined, supersedesId: null } });
    await db.document.deleteMany();

    const run = await proposeRecostChanges(estimateId, "user-1");
    expect(run.proposed).toBe(0);
    expect(completions).not.toHaveBeenCalled();
  });
});
