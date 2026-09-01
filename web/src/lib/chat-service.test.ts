import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { RateLimitError } from "@/lib/rate-limit";
import { createEstimateVersion } from "@/lib/estimate-service";
import { getCitableLineItems, getCitableQuotes, sendMessage } from "@/lib/chat-service";

afterEach(async () => {
  await db.chatMessage.deleteMany();
  await db.chatThread.deleteMany();
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

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
}

// OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
// document-summary-service.test.ts. These verify the config-guard and
// rate-limit mechanics, not a real completion (that needs a real key).
describe("sendMessage", () => {
  it("throws AiNotConfiguredError before creating a thread or saving the message", async () => {
    const opportunity = await makeOpportunity();

    await expect(sendMessage(opportunity.id, "user-1", "hello")).rejects.toBeInstanceOf(AiNotConfiguredError);

    expect(await db.chatThread.findUnique({ where: { opportunityId: opportunity.id } })).toBeNull();
    expect(await db.chatMessage.count()).toBe(0);
  });

  it("rate-limits by user id, independent of the AI configuration error", async () => {
    const opportunity = await makeOpportunity();
    const userId = randomUUID();

    // The limit (20) is checked before the config check, so it's exercised
    // even though every one of these calls will also hit AiNotConfiguredError.
    for (let i = 0; i < 20; i++) {
      await expect(sendMessage(opportunity.id, userId, `msg ${i}`)).rejects.toBeInstanceOf(AiNotConfiguredError);
    }

    await expect(sendMessage(opportunity.id, userId, "one too many")).rejects.toBeInstanceOf(RateLimitError);
  });
});

describe("getCitableLineItems", () => {
  it("returns every live estimate's current-version line items, tagged with their own estimate id", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Booth A" } });
    const version = await createEstimateVersion(estimate.id);
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
    });
    const lineItem = await db.lineItem.create({
      data: { sectionId: section.id, lineType: "MATERIAL", description: "10x10 aluminum frame", qty: 1, unitCost: 1, totalCost: 1 },
    });

    const result = await getCitableLineItems(opportunity.id);

    expect(result).toEqual([{ id: lineItem.id, estimateId: estimate.id, description: "10x10 aluminum frame" }]);
  });

  it("excludes an archived estimate's line items", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id);
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
    });
    await db.lineItem.create({
      data: { sectionId: section.id, lineType: "MATERIAL", description: "Should not appear", qty: 1, unitCost: 1, totalCost: 1 },
    });
    // Archived directly (not via archiveEstimateAction) -- only the
    // resulting DB state matters for this query, and every real
    // archiving path is already exercised by estimate-service.test.ts.
    await db.estimate.update({ where: { id: estimate.id }, data: { archivedAt: new Date() } });

    expect(await getCitableLineItems(opportunity.id)).toEqual([]);
  });
});

describe("getCitableQuotes", () => {
  it("links a sourced line item's quote to its precise document citation", async () => {
    const opportunity = await makeOpportunity();
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "RFP Final.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "x",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
      },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id);
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
    });
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "10x10 aluminum frame",
        qty: 1,
        unitCost: 1,
        totalCost: 1,
        documentId: document.id,
        sourceQuote: "10' x 10' anodized aluminum frame system",
        sourcePageNumber: 4,
      },
    });

    const result = await getCitableQuotes(opportunity.id);

    expect(result).toEqual([
      {
        match: "10' x 10' anodized aluminum frame system",
        href: `/opportunities/${opportunity.id}/documents/${document.id}/view?page=4&q=${encodeURIComponent("10' x 10' anodized aluminum frame system")}`,
      },
    ]);
  });

  it("skips a line item with no sourceQuote at all", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id);
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
    });
    await db.lineItem.create({
      data: { sectionId: section.id, lineType: "MATERIAL", description: "Manually added item", qty: 1, unitCost: 1, totalCost: 1 },
    });

    expect(await getCitableQuotes(opportunity.id)).toEqual([]);
  });
});
