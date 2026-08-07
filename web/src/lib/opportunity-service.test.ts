import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { changeOpportunityStage, convertOpportunityToEstimate } from "@/lib/opportunity-service";

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show" },
  });
  return opportunity;
}

// Tear down between tests rather than wrapping each in a transaction --
// the functions under test call db.$transaction themselves, and nested
// transactions would mask exactly the atomicity bugs these tests exist to
// catch.
afterEach(async () => {
  await db.stageChangeEvent.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.contact.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("changeOpportunityStage", () => {
  it("updates the stage and logs a StageChangeEvent atomically", async () => {
    const opportunity = await makeOpportunity();
    expect(opportunity.stage).toBe("NEW");

    const updated = await changeOpportunityStage(opportunity.id, "CONTACTED", "left voicemail");
    expect(updated.stage).toBe("CONTACTED");

    const events = await db.stageChangeEvent.findMany({
      where: { opportunityId: opportunity.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStage: "NEW",
      toStage: "CONTACTED",
      note: "left voicemail",
    });
  });

  it("records fromStage correctly across multiple transitions", async () => {
    const opportunity = await makeOpportunity();

    await changeOpportunityStage(opportunity.id, "CONTACTED", null);
    await changeOpportunityStage(opportunity.id, "QUALIFIED", null);

    const events = await db.stageChangeEvent.findMany({
      where: { opportunityId: opportunity.id },
      orderBy: { changedAt: "asc" },
    });
    expect(events.map((e) => [e.fromStage, e.toStage])).toEqual([
      ["NEW", "CONTACTED"],
      ["CONTACTED", "QUALIFIED"],
    ]);
  });

  it("throws for a nonexistent opportunity rather than silently no-oping", async () => {
    await expect(
      changeOpportunityStage("does-not-exist", "CONTACTED", null),
    ).rejects.toThrow();
  });
});

describe("convertOpportunityToEstimate", () => {
  it("creates a draft Estimate, advances the stage, and logs the transition", async () => {
    const opportunity = await makeOpportunity();

    const estimate = await convertOpportunityToEstimate(opportunity.id);

    expect(estimate.status).toBe("DRAFT");
    expect(estimate.opportunityId).toBe(opportunity.id);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.stage).toBe("ESTIMATING");

    const events = await db.stageChangeEvent.findMany({
      where: { opportunityId: opportunity.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ fromStage: "NEW", toStage: "ESTIMATING" });
  });

  it("preserves fromStage when converting from a later stage", async () => {
    const opportunity = await makeOpportunity();
    await changeOpportunityStage(opportunity.id, "QUALIFIED", null);

    await convertOpportunityToEstimate(opportunity.id);

    const events = await db.stageChangeEvent.findMany({
      where: { opportunityId: opportunity.id },
      orderBy: { changedAt: "asc" },
    });
    expect(events.at(-1)).toMatchObject({ fromStage: "QUALIFIED", toStage: "ESTIMATING" });
  });

  it("allows multiple estimates per opportunity (no uniqueness assumption)", async () => {
    const opportunity = await makeOpportunity();

    await convertOpportunityToEstimate(opportunity.id);
    await convertOpportunityToEstimate(opportunity.id);

    const estimates = await db.estimate.findMany({ where: { opportunityId: opportunity.id } });
    expect(estimates).toHaveLength(2);
  });
});
