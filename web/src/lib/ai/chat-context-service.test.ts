import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildChatContext } from "@/lib/ai/chat-context-service";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Acme Co" } });
  return db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show", boothNumber: "1234" },
  });
}

describe("buildChatContext", () => {
  it("includes the opportunity's own details even with no documents", async () => {
    const opportunity = await makeOpportunity();

    const context = await buildChatContext(opportunity.id);

    expect(context.systemPrompt).toContain("Test Show");
    expect(context.systemPrompt).toContain("Acme Co");
    expect(context.systemPrompt).toContain("Booth 1234");
    expect(context.documentsIncluded).toEqual([]);
  });

  it("orders documents by priority: RFP before SCHEDULE, and skips docs with no extracted text", async () => {
    const opportunity = await makeOpportunity();
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "schedule.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "x",
        documentType: "SCHEDULE",
        extractionStatus: "COMPLETE",
        extractedText: "SCHEDULE_MARKER",
      },
    });
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "rfp.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "y",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
        extractedText: "RFP_MARKER",
      },
    });
    // Not analyzed -- no extractedText -- must not appear at all.
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "pending.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "z",
        documentType: "CONTRACT",
        extractionStatus: "PENDING",
      },
    });

    const context = await buildChatContext(opportunity.id);

    expect(context.documentsIncluded).toEqual(["rfp.pdf", "schedule.pdf"]);
    expect(context.systemPrompt.indexOf("RFP_MARKER")).toBeLessThan(context.systemPrompt.indexOf("SCHEDULE_MARKER"));
    expect(context.systemPrompt).not.toContain("pending.pdf");
  });

  it("drops the lowest-priority document that doesn't fit the budget, keeping higher-priority ones", async () => {
    const opportunity = await makeOpportunity();
    // A budget-buster: bigger than MAX_CONTEXT_CHARS on its own so it's
    // guaranteed to be dropped regardless of what else is present.
    const huge = "x".repeat(200_000);
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "huge-schedule.pdf",
        mimeType: "application/pdf",
        sizeBytes: huge.length,
        storageKey: "huge",
        documentType: "SCHEDULE",
        extractionStatus: "COMPLETE",
        extractedText: huge,
      },
    });
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "rfp.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "small",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
        extractedText: "RFP_MARKER",
      },
    });

    const context = await buildChatContext(opportunity.id);

    expect(context.documentsIncluded).toEqual(["rfp.pdf"]);
    expect(context.documentsDropped).toEqual(["huge-schedule.pdf"]);
  });
});
