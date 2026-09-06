import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  CANONICAL_MILESTONES,
  buildDeterministicMilestones,
  applyRushFeeDefaults,
  applyAiSuggestions,
  buildEmptyMilestones,
  updateTimelineMilestone,
  regenerateTimeline,
  getTimelineData,
  type TimelineMilestone,
} from "@/lib/timeline-service";
import type { TimelineMilestoneSuggestion } from "@/lib/ai/timeline-service";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity(fields: Partial<{ targetMoveIn: Date; targetMoveOut: Date; eventStartDate: Date; shipDate: Date }> = {}) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show", ...fields } });
  return { company, opportunity };
}

describe("buildDeterministicMilestones", () => {
  it("returns all 11 canonical milestones, in canonical order", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: null,
      shipDate: null,
    });
    expect(milestones.map((m) => m.type)).toEqual(CANONICAL_MILESTONES.map((m) => m.type));
  });

  it("maps INSTALLATION/DISMANTLE/SHOW_OPEN/SHIPPING straight from the matching Opportunity field, confirmed", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: new Date("2027-01-22"),
      targetMoveOut: new Date("2027-01-29"),
      eventStartDate: new Date("2027-01-26"),
      shipDate: new Date("2027-01-04"),
    });
    const byType = new Map(milestones.map((m) => [m.type, m]));
    expect(byType.get("INSTALLATION")?.date).toBe(new Date("2027-01-22").toISOString());
    expect(byType.get("INSTALLATION")?.source).toBe("DETERMINISTIC");
    expect(byType.get("INSTALLATION")?.confirmed).toBe(true);
    expect(byType.get("DISMANTLE")?.date).toBe(new Date("2027-01-29").toISOString());
    expect(byType.get("SHOW_OPEN")?.date).toBe(new Date("2027-01-26").toISOString());
    expect(byType.get("SHIPPING")?.date).toBe(new Date("2027-01-04").toISOString());
  });

  it("leaves a deterministic milestone null and unconfirmed when its Opportunity field is unset", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: null,
      shipDate: null,
    });
    const installation = milestones.find((m) => m.type === "INSTALLATION")!;
    expect(installation.date).toBeNull();
    expect(installation.confirmed).toBe(false);
  });

  it("leaves the 7 non-deterministic milestones null, unconfirmed, source MANUAL", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: null,
      shipDate: null,
    });
    for (const type of ["SIGNED_PROPOSAL", "DEPOSIT_DUE", "PRODUCTION_MEETING", "ARTWORK_DEADLINE", "ARTWORK_RUSH_50", "ARTWORK_RUSH_100", "BALANCE_DUE"]) {
      const m = milestones.find((x) => x.type === type)!;
      expect(m.date).toBeNull();
      expect(m.source).toBe("MANUAL");
      expect(m.confirmed).toBe(false);
    }
  });
});

describe("applyRushFeeDefaults", () => {
  it("fills ARTWORK_RUSH_50/100 as 14/21 days after ARTWORK_DEADLINE when both are still unset", () => {
    const milestones = buildEmptyMilestones().map((m) =>
      m.type === "ARTWORK_DEADLINE" ? { ...m, date: new Date("2026-12-07").toISOString() } : m,
    );
    const result = applyRushFeeDefaults(milestones);
    const byType = new Map(result.map((m) => [m.type, m]));

    expect(byType.get("ARTWORK_RUSH_50")?.date).toBe(new Date("2026-12-21").toISOString());
    expect(byType.get("ARTWORK_RUSH_50")?.source).toBe("COMPUTED");
    expect(byType.get("ARTWORK_RUSH_50")?.confirmed).toBe(false);
    expect(byType.get("ARTWORK_RUSH_100")?.date).toBe(new Date("2026-12-28").toISOString());
  });

  it("is a no-op when ARTWORK_DEADLINE itself is unknown", () => {
    const milestones = buildEmptyMilestones();
    const result = applyRushFeeDefaults(milestones);
    expect(result.find((m) => m.type === "ARTWORK_RUSH_50")?.date).toBeNull();
    expect(result.find((m) => m.type === "ARTWORK_RUSH_100")?.date).toBeNull();
  });

  it("never overwrites a rush-fee date that's already set", () => {
    const overridden = new Date("2026-11-01").toISOString();
    const milestones: TimelineMilestone[] = buildEmptyMilestones().map((m) => {
      if (m.type === "ARTWORK_DEADLINE") return { ...m, date: new Date("2026-12-07").toISOString() };
      if (m.type === "ARTWORK_RUSH_50") return { ...m, date: overridden, source: "MANUAL", confirmed: true };
      return m;
    });
    const result = applyRushFeeDefaults(milestones);
    expect(result.find((m) => m.type === "ARTWORK_RUSH_50")?.date).toBe(overridden);
  });
});

describe("applyAiSuggestions", () => {
  function suggestion(type: TimelineMilestoneSuggestion["type"], date: string): TimelineMilestoneSuggestion {
    return { type, date: new Date(date).toISOString(), sourceQuote: "quote", documentId: "doc-1", pageNumber: 1 };
  }

  it("applies a suggestion unconditionally for a type with no competing structured field", () => {
    const milestones = buildEmptyMilestones();
    const result = applyAiSuggestions(milestones, [suggestion("DEPOSIT_DUE", "2026-09-23")]);
    const deposit = result.find((m) => m.type === "DEPOSIT_DUE")!;
    expect(deposit.date).toBe(new Date("2026-09-23").toISOString());
    expect(deposit.source).toBe("AI_SUGGESTED");
    expect(deposit.confirmed).toBe(false);
  });

  it("prefers a real structured-field value over an AI suggestion for the same type -- confirmed live regression", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: new Date("2027-01-22"),
      targetMoveOut: null,
      eventStartDate: null,
      shipDate: null,
    });
    const result = applyAiSuggestions(milestones, [suggestion("INSTALLATION", "2027-01-15")]);
    const installation = result.find((m) => m.type === "INSTALLATION")!;
    expect(installation.date).toBe(new Date("2027-01-22").toISOString());
    expect(installation.source).toBe("DETERMINISTIC");
  });

  it("flags a conflict when the winning structured field disagrees with what a document states -- confirmed live: Show Open read Jan 3 while its own document said Jan 7", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: new Date("2027-01-03"),
      shipDate: null,
    });
    const result = applyAiSuggestions(milestones, [suggestion("SHOW_OPEN", "2027-01-07")]);
    const showOpen = result.find((m) => m.type === "SHOW_OPEN")!;
    expect(showOpen.date).toBe(new Date("2027-01-03").toISOString());
    expect(showOpen.source).toBe("DETERMINISTIC");
    expect(showOpen.conflict?.date).toBe(new Date("2027-01-07").toISOString());
    expect(showOpen.conflict?.documentId).toBe("doc-1");
  });

  it("does not flag a conflict when the document agrees with the structured field", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: new Date("2027-01-07"),
      shipDate: null,
    });
    const result = applyAiSuggestions(milestones, [suggestion("SHOW_OPEN", "2027-01-07")]);
    expect(result.find((m) => m.type === "SHOW_OPEN")?.conflict).toBeNull();
  });

  it("falls back to an AI suggestion for a structured-field type when that field is still empty -- the real bug this fixes", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: null,
      shipDate: null,
    });
    const result = applyAiSuggestions(milestones, [
      suggestion("INSTALLATION", "2027-01-22"),
      suggestion("DISMANTLE", "2027-01-29"),
      suggestion("SHOW_OPEN", "2027-01-26"),
      suggestion("SHIPPING", "2027-01-04"),
    ]);
    expect(result.find((m) => m.type === "INSTALLATION")?.date).toBe(new Date("2027-01-22").toISOString());
    expect(result.find((m) => m.type === "INSTALLATION")?.source).toBe("AI_SUGGESTED");
    expect(result.find((m) => m.type === "DISMANTLE")?.date).toBe(new Date("2027-01-29").toISOString());
    expect(result.find((m) => m.type === "SHOW_OPEN")?.date).toBe(new Date("2027-01-26").toISOString());
    expect(result.find((m) => m.type === "SHIPPING")?.date).toBe(new Date("2027-01-04").toISOString());
  });
});

describe("updateTimelineMilestone", () => {
  it("seeds the full 11-row skeleton on first edit, when no Timeline has ever been generated", async () => {
    const { opportunity } = await makeOpportunity();
    const data = await updateTimelineMilestone(opportunity.id, "DEPOSIT_DUE", {
      date: new Date("2026-09-23"),
      responsibleParty: "CLIENT",
    });
    expect(data.milestones).toHaveLength(11);
    const deposit = data.milestones.find((m) => m.type === "DEPOSIT_DUE")!;
    expect(deposit.date).toBe(new Date("2026-09-23").toISOString());
    expect(deposit.source).toBe("MANUAL");
    expect(deposit.confirmed).toBe(true);
  });

  it("updates exactly the targeted row, leaving every other row untouched", async () => {
    const { opportunity } = await makeOpportunity();
    await updateTimelineMilestone(opportunity.id, "DEPOSIT_DUE", { date: new Date("2026-09-23"), responsibleParty: "CLIENT" });
    const data = await updateTimelineMilestone(opportunity.id, "BALANCE_DUE", { date: new Date("2026-12-30"), responsibleParty: "CLIENT" });

    expect(data.milestones.find((m) => m.type === "DEPOSIT_DUE")?.date).toBe(new Date("2026-09-23").toISOString());
    expect(data.milestones.find((m) => m.type === "BALANCE_DUE")?.date).toBe(new Date("2026-12-30").toISOString());
  });

  it("clears a stale conflict flag once the estimator directly edits that row", async () => {
    const { opportunity } = await makeOpportunity({ eventStartDate: new Date("2027-01-03") });
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Project Timeline.png",
        mimeType: "image/png",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
        extractedText: null,
        extractedSummary: {
          eventOrProjectName: null,
          venue: null,
          submissionDeadline: null,
          // Full label coverage for every AI-eligible type -- regenerateTimeline
          // always requests all 9, and a type left without a candidate here
          // would otherwise force a real OpenAI call (.env.test has no key).
          keyDates: [
            { label: "Signed Proposal", date: "2026-09-18", dateType: "MILESTONE", sourceQuote: "Signed Proposal", pageNumber: 1 },
            { label: "Deposit Due", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "Deposit Due", pageNumber: 1 },
            { label: "Production Meeting", date: "2026-09-25", dateType: "MILESTONE", sourceQuote: "Production Meeting", pageNumber: 1 },
            { label: "Production Ready Artwork", date: "2026-12-07", dateType: "DEADLINE", sourceQuote: "Production Ready Artwork", pageNumber: 1 },
            { label: "Balance Due", date: "2026-12-30", dateType: "DEADLINE", sourceQuote: "Balance Due", pageNumber: 1 },
            { label: "Shipping to Show Site", date: "2027-01-04", dateType: "MILESTONE", sourceQuote: "Shipping to Show Site", pageNumber: 1 },
            { label: "Installation", date: "2027-01-06", dateType: "MILESTONE", sourceQuote: "Installation", pageNumber: 1 },
            { label: "Show Open", date: "2027-01-07", dateType: "MILESTONE", sourceQuote: "Show Open", pageNumber: 1 },
            { label: "Dismantle", date: "2027-01-10", dateType: "MILESTONE", sourceQuote: "Dismantle", pageNumber: 1 },
          ],
          scopeSummary: [],
          riskFlags: [],
        },
      },
    });

    const regenerated = await regenerateTimeline(opportunity.id, null);
    expect(regenerated.milestones.find((m) => m.type === "SHOW_OPEN")?.conflict).not.toBeNull();

    const edited = await updateTimelineMilestone(opportunity.id, "SHOW_OPEN", {
      date: new Date("2027-01-07"),
      responsibleParty: "CLIENT",
    });
    expect(edited.milestones.find((m) => m.type === "SHOW_OPEN")?.conflict).toBeNull();
  });

  it("clears a milestone's date back to null when given an empty date", async () => {
    const { opportunity } = await makeOpportunity();
    await updateTimelineMilestone(opportunity.id, "DEPOSIT_DUE", { date: new Date("2026-09-23"), responsibleParty: "CLIENT" });
    const data = await updateTimelineMilestone(opportunity.id, "DEPOSIT_DUE", { date: null, responsibleParty: "CLIENT" });
    expect(data.milestones.find((m) => m.type === "DEPOSIT_DUE")?.date).toBeNull();
  });
});

describe("regenerateTimeline", () => {
  it("populates deterministic + rush-fee-default milestones with no scope documents at all (no OpenAI call needed)", async () => {
    const { opportunity } = await makeOpportunity({
      targetMoveIn: new Date("2027-01-22"),
      targetMoveOut: new Date("2027-01-29"),
      eventStartDate: new Date("2027-01-26"),
      shipDate: new Date("2027-01-04"),
    });

    const data = await regenerateTimeline(opportunity.id, null);
    const byType = new Map(data.milestones.map((m) => [m.type, m]));

    expect(byType.get("INSTALLATION")?.date).toBe(new Date("2027-01-22").toISOString());
    expect(byType.get("SHOW_OPEN")?.confirmed).toBe(true);
    // No ARTWORK_DEADLINE known yet -- rush defaults can't compute either.
    expect(byType.get("ARTWORK_RUSH_50")?.date).toBeNull();

    const stored = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(getTimelineData(stored.timelineMilestones)?.milestones).toHaveLength(11);
  });

  it("re-attempts a still-empty row on a later regenerate rather than freezing it forever -- the real production bug", async () => {
    const { opportunity } = await makeOpportunity();

    // First regenerate, no scope documents yet -- DEPOSIT_DUE (one of the
    // 7 types with no structured Opportunity field) gets written with
    // emptyMilestone's own baseline: source MANUAL, date null. This alone
    // used to permanently block every future regenerate from ever filling
    // it in, regardless of what documents later got analyzed.
    const first = await regenerateTimeline(opportunity.id, null);
    expect(first.milestones.find((m) => m.type === "DEPOSIT_DUE")?.source).toBe("MANUAL");
    expect(first.milestones.find((m) => m.type === "DEPOSIT_DUE")?.date).toBeNull();

    // A scope document with clean, unambiguous key dates for every
    // AI-eligible type shows up later (all label-matchable, so this stays
    // within reach of a test env with no OPENAI_API_KEY -- regenerateTimeline
    // always requests all 9 AI-eligible types, not just DEPOSIT_DUE, so any
    // type left without a candidate here would otherwise force a real
    // OpenAI call).
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Project Timeline.png",
        mimeType: "image/png",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
        extractedText: null,
        extractedSummary: {
          eventOrProjectName: null,
          venue: null,
          submissionDeadline: null,
          keyDates: [
            { label: "Signed Proposal", date: "2026-09-18", dateType: "MILESTONE", sourceQuote: "Signed Proposal", pageNumber: 1 },
            { label: "50% Deposit: Initiates Build", date: "2026-09-23", dateType: "DEADLINE", sourceQuote: "50% Deposit: Initiates Build", pageNumber: 1 },
            { label: "Production Meeting", date: "2026-09-25", dateType: "MILESTONE", sourceQuote: "Production Meeting", pageNumber: 1 },
            { label: "Production Ready Artwork", date: "2026-12-07", dateType: "DEADLINE", sourceQuote: "Production Ready Artwork", pageNumber: 1 },
            { label: "Balance Due prior to shipping", date: "2026-12-30", dateType: "DEADLINE", sourceQuote: "Balance Due prior to shipping", pageNumber: 1 },
            { label: "Shipping to Show Site", date: "2027-01-04", dateType: "MILESTONE", sourceQuote: "Shipping to Show Site", pageNumber: 1 },
            { label: "Installation", date: "2027-01-22", dateType: "MILESTONE", sourceQuote: "Installation", pageNumber: 1 },
            { label: "Show Open", date: "2027-01-26", dateType: "MILESTONE", sourceQuote: "Show Open", pageNumber: 1 },
            { label: "Dismantle", date: "2027-01-29", dateType: "MILESTONE", sourceQuote: "Dismantle", pageNumber: 1 },
          ],
          scopeSummary: [],
          riskFlags: [],
        },
      },
    });

    const second = await regenerateTimeline(opportunity.id, null);
    const byType = new Map(second.milestones.map((m) => [m.type, m]));
    // Every one of the 5 non-field-backed types (all previously frozen at
    // MANUAL/null by the first regenerate above) is now unfrozen.
    for (const type of ["SIGNED_PROPOSAL", "DEPOSIT_DUE", "PRODUCTION_MEETING", "ARTWORK_DEADLINE", "BALANCE_DUE"] as const) {
      expect(byType.get(type)?.date).not.toBeNull();
      expect(byType.get(type)?.source).toBe("AI_SUGGESTED");
    }
    expect(byType.get("DEPOSIT_DUE")?.date).toBe(new Date("2026-09-23").toISOString());
  });

  it("computes rush-fee defaults off a MANUALLY-set ARTWORK_DEADLINE, not the freshly-rebuilt (null) one", async () => {
    const { opportunity } = await makeOpportunity();
    await regenerateTimeline(opportunity.id, null);
    await updateTimelineMilestone(opportunity.id, "ARTWORK_DEADLINE", { date: new Date("2026-12-07"), responsibleParty: "CLIENT" });

    const data = await regenerateTimeline(opportunity.id, null);
    const byType = new Map(data.milestones.map((m) => [m.type, m]));

    expect(byType.get("ARTWORK_DEADLINE")?.date).toBe(new Date("2026-12-07").toISOString());
    expect(byType.get("ARTWORK_RUSH_50")?.date).toBe(new Date("2026-12-21").toISOString());
    expect(byType.get("ARTWORK_RUSH_100")?.date).toBe(new Date("2026-12-28").toISOString());
  });

  it("preserves a MANUAL row across a re-run rather than overwriting it with a fresh deterministic value", async () => {
    const { opportunity } = await makeOpportunity({ targetMoveIn: new Date("2027-01-22") });
    await regenerateTimeline(opportunity.id, null);

    // Estimator overrides INSTALLATION by hand after the first regenerate.
    const overridden = new Date("2027-01-15");
    await updateTimelineMilestone(opportunity.id, "INSTALLATION", { date: overridden, responsibleParty: "EXPO_CC" });

    const data = await regenerateTimeline(opportunity.id, null);
    const installation = data.milestones.find((m) => m.type === "INSTALLATION")!;
    expect(installation.date).toBe(overridden.toISOString());
    expect(installation.source).toBe("MANUAL");
  });
});
