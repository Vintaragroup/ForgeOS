import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  applyExtractedFieldsToOpportunity,
  changeOpportunityStage,
  convertOpportunityToEstimate,
} from "@/lib/opportunity-service";

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

  it("records closeReason/closeReasonDetail when moving to LOST", async () => {
    const opportunity = await makeOpportunity();

    const updated = await changeOpportunityStage(opportunity.id, "LOST", null, "PRICE", "Client went with a cheaper bid");

    expect(updated.closeReason).toBe("PRICE");
    expect(updated.closeReasonDetail).toBe("Client went with a cheaper bid");
  });

  it("records closeReason when moving to WON", async () => {
    const opportunity = await makeOpportunity();

    const updated = await changeOpportunityStage(opportunity.id, "WON", null, "RELATIONSHIP", null);

    expect(updated.closeReason).toBe("RELATIONSHIP");
  });

  it("ignores a closeReason passed for a non-closing stage", async () => {
    const opportunity = await makeOpportunity();

    const updated = await changeOpportunityStage(opportunity.id, "CONTACTED", null, "PRICE", "should be ignored");

    expect(updated.closeReason).toBeNull();
    expect(updated.closeReasonDetail).toBeNull();
  });

  it("clears closeReason when a closed deal is reopened to an active stage", async () => {
    const opportunity = await makeOpportunity();
    await changeOpportunityStage(opportunity.id, "LOST", null, "COMPETITOR", "Lost to Acme Corp");

    const reopened = await changeOpportunityStage(opportunity.id, "QUALIFIED", "reopening -- client came back", null, null);

    expect(reopened.closeReason).toBeNull();
    expect(reopened.closeReasonDetail).toBeNull();
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

describe("applyExtractedFieldsToOpportunity", () => {
  it("fills empty fields from extracted values, including parsing a free-text date", async () => {
    const opportunity = await makeOpportunity();

    await applyExtractedFieldsToOpportunity(opportunity.id, [
      { field: "boothNumber", value: "1234" },
      { field: "boothSize", value: "20x20" },
      { field: "eventStartDate", value: "March 5, 2027" },
    ]);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.boothNumber).toBe("1234");
    expect(updated.boothSize).toBe("20x20");
    expect(updated.eventStartDate?.toISOString().slice(0, 10)).toBe("2027-03-05");
  });

  it("never overwrites a field that's already set, even with a different extracted value", async () => {
    const opportunity = await makeOpportunity();
    await db.opportunity.update({ where: { id: opportunity.id }, data: { boothNumber: "already set by hand" } });

    await applyExtractedFieldsToOpportunity(opportunity.id, [{ field: "boothNumber", value: "9999" }]);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.boothNumber).toBe("already set by hand");
  });

  it("ignores an unparseable date rather than writing garbage", async () => {
    const opportunity = await makeOpportunity();

    await applyExtractedFieldsToOpportunity(opportunity.id, [{ field: "shipDate", value: "not a real date" }]);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.shipDate).toBeNull();
  });

  it("is a no-op for an empty extractedFields array -- no query, no write", async () => {
    const opportunity = await makeOpportunity();

    await applyExtractedFieldsToOpportunity(opportunity.id, []);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.boothNumber).toBeNull();
  });

  it("skips auto-apply entirely once the opportunity has 2+ named estimates -- which project's booth number would this even be?", async () => {
    const opportunity = await makeOpportunity();
    await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Full Swing Baseball" } });
    await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Full Swing PGA" } });

    await applyExtractedFieldsToOpportunity(opportunity.id, [{ field: "boothNumber", value: "1234" }]);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.boothNumber).toBeNull();
  });

  it("still applies normally with only one named estimate -- the guard is specifically about 2+", async () => {
    const opportunity = await makeOpportunity();
    await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Only One" } });

    await applyExtractedFieldsToOpportunity(opportunity.id, [{ field: "boothNumber", value: "1234" }]);

    const updated = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(updated.boothNumber).toBe("1234");
  });
});
