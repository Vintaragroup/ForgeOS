import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildChatContext } from "@/lib/ai/chat-context-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";

afterEach(async () => {
  await db.documentChunk.deleteMany();
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
  const company = await db.company.create({ data: { name: "Acme Co" } });
  return db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show", boothNumber: "1234" },
  });
}

describe("buildChatContext", () => {
  it("includes the opportunity's own details even with no documents", async () => {
    const opportunity = await makeOpportunity();

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.systemPrompt).toContain("Test Show");
    expect(context.systemPrompt).toContain("Acme Co");
    expect(context.systemPrompt).toContain("Booth 1234");
    expect(context.documentsIncluded).toEqual([]);
  });

  it("orders documents by priority: RFP before SCHEDULE, and lists (but doesn't dump the body of) a doc with no extracted text", async () => {
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
    // Not analyzed -- no extractedText -- its body must not appear, but the
    // model still needs to know it exists (see chat-context-service.ts's
    // "DOCUMENTS ON THIS OPPORTUNITY" comment: an invisible-by-name
    // document is undiscoverable no matter what the user asks).
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

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.documentsIncluded).toEqual(["rfp.pdf", "schedule.pdf"]);
    expect(context.systemPrompt.indexOf("RFP_MARKER")).toBeLessThan(context.systemPrompt.indexOf("SCHEDULE_MARKER"));
    expect(context.systemPrompt).toMatch(/DOCUMENTS ON THIS OPPORTUNITY.*pending\.pdf \(CONTRACT, pending\)/);
    expect(context.systemPrompt).not.toContain("DOCUMENT: pending.pdf"); // no body dumped -- there's none to dump
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

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.documentsIncluded).toEqual(["rfp.pdf"]);
    expect(context.documentsDropped).toEqual(["huge-schedule.pdf"]);
  });

  it("includes real line items from the current version, confirmed ones before drafts", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id);
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
    });
    // Draft created first -- proves ordering comes from isDraft, not
    // insertion order.
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "Unreviewed graphic panel",
        qty: 1,
        unitCost: 100,
        totalCost: 100,
        isDraft: true,
      },
    });
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "10x10 aluminum frame",
        category: "Structure",
        qty: 2,
        unit: "ea",
        unitCost: 450,
        totalCost: 900,
        isDraft: false,
      },
    });

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.systemPrompt).toContain("[CONFIRMED] Structure: 10x10 aluminum frame");
    expect(context.systemPrompt).toContain("[DRAFT] Structure: Unreviewed graphic panel");
    expect(context.systemPrompt.indexOf("aluminum frame")).toBeLessThan(context.systemPrompt.indexOf("graphic panel"));
    expect(context.lineItemsOmitted).toBe(0);
  });

  it("surfaces a sourced line item's document, page, and quote as real grounding", async () => {
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

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.systemPrompt).toContain('↳ from "10\' x 10\' anodized aluminum frame system" -- RFP Final.pdf, p.4');
  });

  it("truncates a long sourceQuote in context, without an ellipsis in the matchable prefix", async () => {
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
    const longQuote = "x".repeat(200);
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "Long-quoted item",
        qty: 1,
        unitCost: 1,
        totalCost: 1,
        documentId: document.id,
        sourceQuote: longQuote,
        sourcePageNumber: 1,
      },
    });

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.systemPrompt).toContain(`"${"x".repeat(140)}…"`);
    expect(context.systemPrompt).not.toContain("x".repeat(141));
  });

  it("surfaces every named Estimate on the Opportunity, not just the most recently created one", async () => {
    const opportunity = await makeOpportunity();

    const older = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Booth A" } });
    const olderVersion = await createEstimateVersion(older.id);
    const olderSection = await db.estimateSection.create({
      data: { estimateVersionId: olderVersion.id, name: "Structure", sectionType: "CATEGORY" },
    });
    await db.lineItem.create({
      data: { sectionId: olderSection.id, lineType: "MATERIAL", description: "Frame for A", qty: 1, unitCost: 1, totalCost: 1 },
    });

    const newer = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Booth B" } });
    const newerVersion = await createEstimateVersion(newer.id);
    const newerSection = await db.estimateSection.create({
      data: { estimateVersionId: newerVersion.id, name: "Furniture", sectionType: "CATEGORY" },
    });
    await db.lineItem.create({
      data: { sectionId: newerSection.id, lineType: "MATERIAL", description: "Panel for B", qty: 1, unitCost: 1, totalCost: 1 },
    });

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.systemPrompt).toContain("ESTIMATE: Booth A");
    expect(context.systemPrompt).toContain("ESTIMATE: Booth B");
    expect(context.systemPrompt).toContain("Frame for A");
    expect(context.systemPrompt).toContain("Panel for B");
  });

  it("truncates line items (not the whole estimate) once they exceed the context budget", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id);
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
    });
    // 100 items x ~2000-char descriptions comfortably exceeds the 150k
    // budget -- bulk-inserted since only the total volume matters here,
    // not any per-row distinction.
    await db.lineItem.createMany({
      data: Array.from({ length: 100 }, (_, i) => ({
        sectionId: section.id,
        lineType: "MATERIAL" as const,
        description: `Item ${i} ${"x".repeat(2000)}`,
        qty: 1,
        unitCost: 1,
        totalCost: 1,
      })),
    });

    const context = await buildChatContext(opportunity.id, "What's in this opportunity?");

    expect(context.lineItemsOmitted).toBeGreaterThan(0);
    expect(context.systemPrompt).toContain("more line item(s) not shown here for length");
    // Truncated, not dropped wholesale -- at least the first item made it in.
    expect(context.systemPrompt).toContain("Item 0 ");
  });

  it("switches an indexed document to retrieval instead of the full-text fallback, even if that means requiring OpenAI", async () => {
    // Once a document has real chunks (document-embedding-service.ts),
    // buildChatContext must attempt retrieveRelevantChunks for it rather
    // than silently keeping the old full-text dump -- proven here by the
    // fact that doing so requires OpenAI (unconfigured in this test env,
    // same posture as every other AI-backed test in this suite), which
    // wouldn't be reached at all if the document had fallen through to
    // the plain extractedText path instead.
    const opportunity = await makeOpportunity();
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "indexed.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "x",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
        extractedText: "Full text that the fallback path would otherwise dump in verbatim.",
      },
    });
    const zeroVector = `[${"0,".repeat(1535)}0]`;
    await db.$executeRaw`
      INSERT INTO document_chunks (id, "documentId", "opportunityId", "chunkIndex", content, embedding)
      VALUES (${"chunk1"}, ${document.id}, ${opportunity.id}, ${0}, ${"some indexed text"}, ${zeroVector}::vector)
    `;

    await expect(buildChatContext(opportunity.id, "What's in this opportunity?")).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });
});
