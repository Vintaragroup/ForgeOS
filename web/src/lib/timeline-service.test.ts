import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  CANONICAL_MILESTONES,
  buildDeterministicMilestones,
  describeDerivedRule,
  resolveAnchorDates,
  applyAiSuggestions,
  buildEmptyMilestones,
  updateTimelineMilestone,
  regenerateTimeline,
  getTimelineData,
  getWorkOrderPrefillFromTimeline,
  type TimelineMilestone,
  type TimelineData,
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

  // Used to assert all 7 of these stayed null and MANUAL, waiting on an AI
  // pass to read them off a document. Six of them are now arithmetic off
  // an anchor and the seventh is entered, so with no anchors at all they
  // are still blank -- but blank because nothing has been entered yet,
  // not because nobody has run a model over the paperwork.
  it("leaves every computed milestone blank while its anchors are unset", () => {
    const milestones = buildDeterministicMilestones({
      targetMoveIn: null,
      targetMoveOut: null,
      eventStartDate: null,
      shipDate: null,
      signedProposalTargetDate: null,
    });
    for (const type of ["SIGNED_PROPOSAL", "DEPOSIT_DUE", "PRODUCTION_MEETING", "ARTWORK_DEADLINE", "ARTWORK_RUSH_50", "ARTWORK_RUSH_100", "BALANCE_DUE"]) {
      const m = milestones.find((x) => x.type === type)!;
      expect(m.date, type).toBeNull();
      expect(m.confirmed, type).toBe(false);
    }
  });
});

// The estimating workbook's own arithmetic, PROPOSAL!A14:A24 of the
// Orlando template. Every expected date below was read off that file with
// its formulas resolved, not derived from this implementation.
//
//   ship 2026-12-21  ->  artwork 2026-11-23, 50% 2026-12-07,
//                        100% 2026-12-14, balance 2026-12-16
//   signed 2026-08-20 -> deposit 2026-08-25, production mtg 2026-08-27
describe("the workbook's timeline formula", () => {
  const anchors = {
    targetMoveIn: new Date("2027-01-14"),
    targetMoveOut: new Date("2027-01-21"),
    eventStartDate: new Date("2027-01-19"),
    shipDate: new Date("2026-12-21"),
    signedProposalTargetDate: new Date("2026-08-20"),
  };

  it("reproduces every date the workbook computes", () => {
    const byType = new Map(buildDeterministicMilestones(anchors).map((m) => [m.type, m.date]));
    const day = (d: string) => new Date(d).toISOString();
    expect(byType.get("SIGNED_PROPOSAL")).toBe(day("2026-08-20"));
    expect(byType.get("DEPOSIT_DUE")).toBe(day("2026-08-25"));
    expect(byType.get("PRODUCTION_MEETING")).toBe(day("2026-08-27"));
    expect(byType.get("ARTWORK_DEADLINE")).toBe(day("2026-11-23"));
    expect(byType.get("ARTWORK_RUSH_50")).toBe(day("2026-12-07"));
    expect(byType.get("ARTWORK_RUSH_100")).toBe(day("2026-12-14"));
    expect(byType.get("BALANCE_DUE")).toBe(day("2026-12-16"));
    expect(byType.get("SHIPPING")).toBe(day("2026-12-21"));
    expect(byType.get("INSTALLATION")).toBe(day("2027-01-14"));
    expect(byType.get("SHOW_OPEN")).toBe(day("2027-01-19"));
    expect(byType.get("DISMANTLE")).toBe(day("2027-01-21"));
  });

  // A guessed deadline is worse than a visibly missing one when rush
  // charges hang off it.
  it("leaves a deadline blank when its anchor has not been entered", () => {
    const withoutShip = buildDeterministicMilestones({ ...anchors, shipDate: null });
    const byType = new Map(withoutShip.map((m) => [m.type, m]));
    for (const type of ["ARTWORK_DEADLINE", "ARTWORK_RUSH_50", "ARTWORK_RUSH_100", "BALANCE_DUE"] as const) {
      expect(byType.get(type)?.date, type).toBeNull();
    }
    // The signed-proposal side is unaffected -- one missing anchor does
    // not blank the whole timeline.
    expect(byType.get("DEPOSIT_DUE")?.date).toBe(new Date("2026-08-25").toISOString());
  });

  it("leaves deposit and production meeting blank until a signing deadline is set", () => {
    const unsigned = buildDeterministicMilestones({ ...anchors, signedProposalTargetDate: null });
    const byType = new Map(unsigned.map((m) => [m.type, m]));
    expect(byType.get("DEPOSIT_DUE")?.date).toBeNull();
    expect(byType.get("PRODUCTION_MEETING")?.date).toBeNull();
    expect(byType.get("ARTWORK_DEADLINE")?.date).toBe(new Date("2026-11-23").toISOString());
  });

  // Computed is not the same as reviewed.
  it("marks a computed date unconfirmed, and an entered one confirmed", () => {
    const byType = new Map(buildDeterministicMilestones(anchors).map((m) => [m.type, m]));
    expect(byType.get("SHIPPING")?.source).toBe("DETERMINISTIC");
    expect(byType.get("SHIPPING")?.confirmed).toBe(true);
    expect(byType.get("BALANCE_DUE")?.source).toBe("COMPUTED");
    expect(byType.get("BALANCE_DUE")?.confirmed).toBe(false);
  });

  it("says which date a blank milestone is waiting on", () => {
    expect(describeDerivedRule("ARTWORK_DEADLINE")).toBe("28 days before shipping date");
    expect(describeDerivedRule("DEPOSIT_DUE")).toBe("5 days after signed-proposal deadline");
    expect(describeDerivedRule("SHIPPING")).toBeNull();
  });
});

describe("resolveAnchorDates", () => {
  const show = {
    targetMoveIn: new Date("2027-01-14"),
    targetMoveOut: new Date("2027-01-21"),
    eventStartDate: new Date("2027-01-19"),
    shipDate: new Date("2026-12-21"),
  };
  const blank = {
    targetMoveIn: null,
    targetMoveOut: null,
    eventStartDate: null,
    shipDate: null,
    signedProposalTargetDate: null,
  };

  // Pick the show, the dates land.
  it("inherits every date from the show when the booth has none", () => {
    expect(resolveAnchorDates(blank, show)).toMatchObject(show);
  });

  // A booth that genuinely ships early says so.
  it("lets the booth override one date without losing the others", () => {
    const early = new Date("2026-12-01");
    const resolved = resolveAnchorDates({ ...blank, shipDate: early }, show);
    expect(resolved.shipDate).toBe(early);
    expect(resolved.targetMoveIn).toBe(show.targetMoveIn);
  });

  it("changes nothing when there is no show", () => {
    expect(resolveAnchorDates(blank, null)).toBe(blank);
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
    // Used to assert these were null: with nothing but structured dates
    // and no documents, the artwork and rush rows had no anchor and waited
    // on an AI pass. They come off the ship date now, so a timeline with
    // no documents at all is already complete. The dates are the same ones
    // the old artwork-anchored rule produced -- 2027-01-04 less 28, 14 and
    // 7 days -- which is the point: same answer, one anchor.
    expect(byType.get("ARTWORK_DEADLINE")?.date).toBe(new Date("2026-12-07").toISOString());
    expect(byType.get("ARTWORK_RUSH_50")?.date).toBe(new Date("2026-12-21").toISOString());
    expect(byType.get("ARTWORK_RUSH_100")?.date).toBe(new Date("2026-12-28").toISOString());
    expect(byType.get("BALANCE_DUE")?.date).toBe(new Date("2026-12-30").toISOString());

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

  // This used to assert that hand-editing ARTWORK_DEADLINE dragged both
  // rush cutoffs along with it. They are anchored to the ship date now,
  // with every other deadline, so moving the artwork deadline moves only
  // the artwork deadline.
  //
  // That is the intended trade. Rush fees are charged on how late artwork
  // lands relative to production, and production is scheduled off the ship
  // date -- so the ship date is what should govern them. It also removes
  // an ordering hazard: the old pass had to run after MANUAL rows were
  // restored, and getting that order wrong silently left both rush rows
  // unset on a real opportunity.
  it("keeps the rush cutoffs on the ship date even when the artwork deadline is overridden", async () => {
    const { opportunity } = await makeOpportunity({ shipDate: new Date("2027-01-04") });
    await regenerateTimeline(opportunity.id, null);
    await updateTimelineMilestone(opportunity.id, "ARTWORK_DEADLINE", { date: new Date("2026-11-01"), responsibleParty: "CLIENT" });

    const data = await regenerateTimeline(opportunity.id, null);
    const byType = new Map(data.milestones.map((m) => [m.type, m]));

    // The override stands.
    expect(byType.get("ARTWORK_DEADLINE")?.date).toBe(new Date("2026-11-01").toISOString());
    // And the rush cutoffs stay where the ship date puts them.
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

describe("getWorkOrderPrefillFromTimeline", () => {
  function withDate(milestones: TimelineMilestone[], type: TimelineMilestone["type"], date: Date, confirmed: boolean): TimelineMilestone[] {
    return milestones.map((m) => (m.type === type ? { ...m, date: date.toISOString(), confirmed } : m));
  }

  it("maps all 5 WorkOrder-relevant milestones by type, regardless of confirmed", () => {
    let milestones = buildEmptyMilestones();
    milestones = withDate(milestones, "DEPOSIT_DUE", new Date("2026-08-15"), true);
    milestones = withDate(milestones, "PRODUCTION_MEETING", new Date("2026-08-20"), false); // AI_SUGGESTED, unconfirmed
    milestones = withDate(milestones, "ARTWORK_DEADLINE", new Date("2026-12-01"), false);
    milestones = withDate(milestones, "BALANCE_DUE", new Date("2026-12-10"), true);
    milestones = withDate(milestones, "INSTALLATION", new Date("2027-01-15"), true);
    const data: TimelineData = { generatedAt: new Date().toISOString(), milestones };

    const prefill = getWorkOrderPrefillFromTimeline(data);

    expect(prefill.depositDueDate?.toISOString()).toBe(new Date("2026-08-15").toISOString());
    // Unconfirmed AI_SUGGESTED still prefills -- see the function's own
    // comment for why requiring confirmed:true here would just relocate
    // the "field silently sits blank" problem onto a different page.
    expect(prefill.productionMeetingDate?.toISOString()).toBe(new Date("2026-08-20").toISOString());
    expect(prefill.artworkDeadlineDate?.toISOString()).toBe(new Date("2026-12-01").toISOString());
    expect(prefill.balanceDueDate?.toISOString()).toBe(new Date("2026-12-10").toISOString());
    expect(prefill.installDate?.toISOString()).toBe(new Date("2027-01-15").toISOString());
  });

  it("returns null for any milestone still unset", () => {
    const data: TimelineData = { generatedAt: new Date().toISOString(), milestones: buildEmptyMilestones() };
    const prefill = getWorkOrderPrefillFromTimeline(data);
    expect(prefill).toEqual({
      depositDueDate: null,
      productionMeetingDate: null,
      artworkDeadlineDate: null,
      balanceDueDate: null,
      installDate: null,
    });
  });

  it("returns all nulls when there's no Timeline at all", () => {
    const prefill = getWorkOrderPrefillFromTimeline(null);
    expect(prefill).toEqual({
      depositDueDate: null,
      productionMeetingDate: null,
      artworkDeadlineDate: null,
      balanceDueDate: null,
      installDate: null,
    });
  });
});
