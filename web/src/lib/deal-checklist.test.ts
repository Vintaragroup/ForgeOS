import { describe, expect, it } from "vitest";
import { buildDealChecklist, daysInStage, type DealChecklistInput } from "@/lib/deal-checklist";

function baseInput(overrides: Partial<DealChecklistInput> = {}): DealChecklistInput {
  return {
    opportunityId: "opp1",
    stage: "QUALIFIED",
    primaryContactId: "contact1",
    ownerId: "user1",
    pendingFieldSuggestionCount: 0,
    documentsNeedingAnalysisCount: 0,
    hasScopeDocuments: false,
    recommendedClarificationQuestionCount: 0,
    bidderQuestionsDeadlineLabel: null,
    missingTimelineMilestoneCount: 0,
    estimateId: null,
    currentVersion: null,
    currentVersionProposals: [],
    projectCount: 0,
    now: new Date("2026-08-13T00:00:00Z"),
    ...overrides,
  };
}

describe("buildDealChecklist", () => {
  it("returns nothing for a LOST deal -- nothing left to action", () => {
    expect(buildDealChecklist(baseInput({ stage: "LOST" }))).toEqual([]);
  });

  it("for a WON deal with no project yet, only suggests converting to a project", () => {
    const items = buildDealChecklist(baseInput({ stage: "WON", estimateId: "est1" }));
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("convert-to-project");
  });

  it("returns nothing for a WON deal that's already been converted to a project", () => {
    expect(buildDealChecklist(baseInput({ stage: "WON", projectCount: 1 }))).toEqual([]);
  });

  it("flags a missing primary contact and owner", () => {
    const items = buildDealChecklist(baseInput({ primaryContactId: null, ownerId: null }));
    expect(items.map((i) => i.id)).toEqual(expect.arrayContaining(["primary-contact", "owner"]));
  });

  it("flags pending field suggestions with a correctly pluralized count", () => {
    const items = buildDealChecklist(baseInput({ pendingFieldSuggestionCount: 3 }));
    const item = items.find((i) => i.id === "field-suggestions");
    expect(item?.label).toContain("3 fields suggested");
  });

  it("flags documents needing analysis", () => {
    const items = buildDealChecklist(baseInput({ documentsNeedingAnalysisCount: 2 }));
    const item = items.find((i) => i.id === "analyze-documents");
    expect(item?.label).toBe("Analyze 2 uploaded documents.");
  });

  it("only surfaces clarification questions when there are BOTH scope documents and recommended questions", () => {
    expect(
      buildDealChecklist(
        baseInput({ hasScopeDocuments: false, recommendedClarificationQuestionCount: 5 }),
      ).map((i) => i.id),
    ).not.toContain("clarification-questions");
    expect(
      buildDealChecklist(
        baseInput({ hasScopeDocuments: true, recommendedClarificationQuestionCount: 0 }),
      ).map((i) => i.id),
    ).not.toContain("clarification-questions");
    const items = buildDealChecklist(
      baseInput({ hasScopeDocuments: true, recommendedClarificationQuestionCount: 2, bidderQuestionsDeadlineLabel: "19 August 2026" }),
    );
    const item = items.find((i) => i.id === "clarification-questions");
    expect(item?.label).toContain("bidder questions due 19 August 2026");
    expect(item?.urgent).toBe(true);
  });

  it("flags missing Timeline milestones as non-urgent while the estimate is still in progress", () => {
    const items = buildDealChecklist(
      baseInput({ missingTimelineMilestoneCount: 4, estimateId: "est1", currentVersion: { isLocked: false, isApproved: false } }),
    );
    const item = items.find((i) => i.id === "timeline-incomplete");
    expect(item?.label).toBe("Fill in 4 missing Timeline milestones before the proposal goes out.");
    expect(item?.href).toBe("/opportunities/opp1#timeline");
    expect(item?.urgent).toBe(false);
  });

  it("pluralizes a single missing Timeline milestone correctly", () => {
    const items = buildDealChecklist(baseInput({ missingTimelineMilestoneCount: 1 }));
    expect(items.find((i) => i.id === "timeline-incomplete")?.label).toBe(
      "Fill in 1 missing Timeline milestone before the proposal goes out.",
    );
  });

  it("makes missing Timeline milestones urgent once the estimate is locked and approved -- right before a proposal would go out", () => {
    const items = buildDealChecklist(
      baseInput({ missingTimelineMilestoneCount: 2, estimateId: "est1", currentVersion: { isLocked: true, isApproved: true } }),
    );
    expect(items.find((i) => i.id === "timeline-incomplete")?.urgent).toBe(true);
  });

  it("says nothing about Timeline once every milestone is filled in", () => {
    const items = buildDealChecklist(baseInput({ missingTimelineMilestoneCount: 0 }));
    expect(items.map((i) => i.id)).not.toContain("timeline-incomplete");
  });

  it("suggests starting an estimate when none exists", () => {
    const items = buildDealChecklist(baseInput({ estimateId: null }));
    expect(items.map((i) => i.id)).toContain("start-estimate");
  });

  it("suggests finalizing the estimate when it exists but isn't locked+approved", () => {
    const items = buildDealChecklist(
      baseInput({ estimateId: "est1", currentVersion: { isLocked: false, isApproved: false } }),
    );
    const item = items.find((i) => i.id === "finalize-estimate");
    expect(item?.href).toBe("/estimates/est1");
  });

  it("suggests generating a proposal once the estimate is locked and approved with no proposal yet", () => {
    const items = buildDealChecklist(
      baseInput({ estimateId: "est1", currentVersion: { isLocked: true, isApproved: true }, currentVersionProposals: [] }),
    );
    expect(items.map((i) => i.id)).toContain("generate-proposal");
  });

  it("suggests sending the proposal once generated but not sent", () => {
    const items = buildDealChecklist(
      baseInput({
        estimateId: "est1",
        currentVersion: { isLocked: true, isApproved: true },
        currentVersionProposals: [{ sentAt: null, signedAt: null }],
      }),
    );
    expect(items.map((i) => i.id)).toContain("send-proposal");
  });

  it("does not nag about following up before the follow-up threshold", () => {
    const items = buildDealChecklist(
      baseInput({
        estimateId: "est1",
        currentVersion: { isLocked: true, isApproved: true },
        currentVersionProposals: [{ sentAt: new Date("2026-08-10T00:00:00Z"), signedAt: null }],
        now: new Date("2026-08-13T00:00:00Z"), // 3 days
      }),
    );
    expect(items.map((i) => i.id)).not.toContain("follow-up-proposal");
  });

  it("flags an urgent follow-up once the proposal has sat unsigned past the threshold", () => {
    const items = buildDealChecklist(
      baseInput({
        estimateId: "est1",
        currentVersion: { isLocked: true, isApproved: true },
        currentVersionProposals: [{ sentAt: new Date("2026-08-01T00:00:00Z"), signedAt: null }],
        now: new Date("2026-08-13T00:00:00Z"), // 12 days
      }),
    );
    const item = items.find((i) => i.id === "follow-up-proposal");
    expect(item?.urgent).toBe(true);
    expect(item?.label).toContain("12 days ago");
  });

  it("suggests nothing about the estimate once the proposal is signed", () => {
    const items = buildDealChecklist(
      baseInput({
        estimateId: "est1",
        currentVersion: { isLocked: true, isApproved: true },
        currentVersionProposals: [{ sentAt: new Date("2026-08-01T00:00:00Z"), signedAt: new Date("2026-08-05T00:00:00Z") }],
      }),
    );
    expect(items.some((i) => ["generate-proposal", "send-proposal", "follow-up-proposal"].includes(i.id))).toBe(false);
  });

  it("returns an empty list when nothing is outstanding -- a healthy, fully-signed deal", () => {
    const items = buildDealChecklist(
      baseInput({
        estimateId: "est1",
        currentVersion: { isLocked: true, isApproved: true },
        currentVersionProposals: [{ sentAt: new Date("2026-08-01T00:00:00Z"), signedAt: new Date("2026-08-05T00:00:00Z") }],
      }),
    );
    expect(items).toEqual([]);
  });
});

describe("daysInStage", () => {
  it("computes whole days between the stage change and now", () => {
    expect(daysInStage(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-13T00:00:00Z"))).toBe(12);
  });
});
