import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addLineItem, addSection, createEstimateVersion, lockEstimateVersion } from "@/lib/estimate-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { suggestBoothDescription, suggestSectionDescription } from "@/lib/ai/section-description-service";

afterEach(async () => {
  await db.lineItemAuditLog.deleteMany();
  await db.estimateSectionCategoryDescription.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.category.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeSection() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  const section = await addSection(version.id, { name: "Custom Build", sectionType: "COMPONENT" });
  return { section, version };
}

describe("suggestSectionDescription", () => {
  // OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
  // document-summary-service.test.ts: this verifies the "AI features not
  // configured" path leaves pendingDescription untouched, not the real
  // OpenAI call itself (that needs a real key, tested manually).
  it("throws AiNotConfiguredError without writing a pendingDescription override", async () => {
    const { section } = await makeSection();
    const category = await db.category.create({ data: { name: "Labor", key: "labor" } });

    await expect(suggestSectionDescription(section.id, category.id, null)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const override = await db.estimateSectionCategoryDescription.findUnique({
      where: { sectionId_categoryId: { sectionId: section.id, categoryId: category.id } },
    });
    expect(override).toBeNull();
  });

  it("rejects on a locked version, without ever reaching the AI call", async () => {
    const { section, version } = await makeSection();
    const category = await db.category.create({ data: { name: "Labor", key: "labor" } });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Plywood", qty: 1, unitCost: 20 });
    await lockEstimateVersion(version.id);

    // A locked version must fail on the lock check, not on the (also-true)
    // missing-API-key condition -- confirms assertUnlocked runs first.
    await expect(suggestSectionDescription(section.id, category.id, null)).rejects.toThrow(/locked/);
  });
});

describe("suggestBoothDescription", () => {
  it("throws AiNotConfiguredError without writing boothPendingDescription on any section sharing the groupLabel", async () => {
    const { version } = await makeSection();
    const groupLabel = "SECTION 211";
    const sectionA = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    const sectionB = await addSection(version.id, { name: "Wall Panels", sectionType: "COMPONENT", groupLabel });

    await expect(suggestBoothDescription(version.id, groupLabel, null)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const [refreshedA, refreshedB] = await Promise.all([
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionA.id } }),
      db.estimateSection.findUniqueOrThrow({ where: { id: sectionB.id } }),
    ]);
    expect(refreshedA.boothPendingDescription).toBeNull();
    expect(refreshedB.boothPendingDescription).toBeNull();
  });

  it("rejects on a locked version, without ever reaching the AI call", async () => {
    const { version } = await makeSection();
    const groupLabel = "SECTION 211";
    const section = await addSection(version.id, { name: "BeMatrix", sectionType: "COMPONENT", groupLabel });
    await addLineItem(version.id, section.id, { lineType: "MATERIAL", description: "Frame", qty: 1, unitCost: 20 });
    await lockEstimateVersion(version.id);

    await expect(suggestBoothDescription(version.id, groupLabel, null)).rejects.toThrow(/locked/);
  });

  it("throws when no section exists for the given groupLabel", async () => {
    const { version } = await makeSection();

    await expect(suggestBoothDescription(version.id, "NO SUCH BOOTH", null)).rejects.toThrow(/no sections/i);
  });
});
