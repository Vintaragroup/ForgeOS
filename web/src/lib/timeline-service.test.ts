import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  CANONICAL_MILESTONES,
  buildDeterministicMilestones,
  applyRushFeeDefaults,
  buildEmptyMilestones,
  updateTimelineMilestone,
  regenerateTimeline,
  getTimelineData,
  type TimelineMilestone,
} from "@/lib/timeline-service";

afterEach(async () => {
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
