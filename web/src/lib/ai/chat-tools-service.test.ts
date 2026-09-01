import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import { executeChatTool } from "@/lib/ai/chat-tools-service";

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
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
}

describe("executeChatTool", () => {
  it("returns a friendly error for malformed JSON arguments, without throwing", async () => {
    const opportunity = await makeOpportunity();
    const result = await executeChatTool("get_line_items", "{not json", { opportunityId: opportunity.id, userId: null });
    expect(result).toMatch(/weren't valid JSON/);
  });

  it("returns a friendly error for an unrecognized tool name", async () => {
    const opportunity = await makeOpportunity();
    const result = await executeChatTool("delete_everything", "{}", { opportunityId: opportunity.id, userId: null });
    expect(result).toMatch(/Unknown tool/);
  });

  describe("get_line_items", () => {
    it("filters by category, section name, draft status, and description text together", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const structure = await db.estimateSection.create({
        data: { estimateVersionId: version.id, name: "Wall Structure", sectionType: "CATEGORY" },
      });
      const labor = await db.estimateSection.create({
        data: { estimateVersionId: version.id, name: "Labor", sectionType: "CATEGORY" },
      });
      await db.lineItem.createMany({
        data: [
          { sectionId: structure.id, lineType: "MATERIAL", description: "10x10 aluminum frame", category: "Structure", qty: 1, unitCost: 1, totalCost: 1, isDraft: false },
          { sectionId: structure.id, lineType: "MATERIAL", description: "Unreviewed graphic panel", category: "Structure", qty: 1, unitCost: 1, totalCost: 1, isDraft: true },
          { sectionId: labor.id, lineType: "LABOR", description: "Install crew, 2 days", category: "Labor", qty: 1, unitCost: 1, totalCost: 1, isDraft: false },
        ],
      });

      const result = await executeChatTool("get_line_items", JSON.stringify({ category: "Structure", isDraft: false }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toContain("aluminum frame");
      expect(result).not.toContain("graphic panel"); // isDraft: false excludes it
      expect(result).not.toContain("Install crew"); // wrong category
    });

    it("reports when nothing matches, and when no estimate is found by name", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const section = await db.estimateSection.create({
        data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
      });
      await db.lineItem.create({
        data: { sectionId: section.id, lineType: "MATERIAL", description: "Frame", qty: 1, unitCost: 1, totalCost: 1 },
      });

      const noMatch = await executeChatTool("get_line_items", JSON.stringify({ searchText: "nonexistent" }), {
        opportunityId: opportunity.id,
        userId: null,
      });
      expect(noMatch).toMatch(/No line items matched/);

      const noEstimate = await executeChatTool("get_line_items", JSON.stringify({ estimateName: "Ghost Estimate" }), {
        opportunityId: opportunity.id,
        userId: null,
      });
      expect(noEstimate).toMatch(/No estimate named "Ghost Estimate"/);
    });

    it("truncates past 60 rows with a trailing count note", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const section = await db.estimateSection.create({
        data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY" },
      });
      await db.lineItem.createMany({
        data: Array.from({ length: 75 }, (_, i) => ({
          sectionId: section.id,
          lineType: "MATERIAL" as const,
          description: `Item ${i}`,
          qty: 1,
          unitCost: 1,
          totalCost: 1,
        })),
      });

      const result = await executeChatTool("get_line_items", "{}", { opportunityId: opportunity.id, userId: null });

      expect(result).toContain("15 more item(s) matched but aren't shown");
      expect(result.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(60);
    });
  });

  describe("get_document_excerpt", () => {
    it("lists available documents when the named one isn't found", async () => {
      const opportunity = await makeOpportunity();
      await db.document.create({
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

      const result = await executeChatTool(
        "get_document_excerpt",
        JSON.stringify({ documentName: "Nonexistent.pdf", query: "booth size" }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/No document named "Nonexistent\.pdf"/);
      expect(result).toContain("RFP Final.pdf");
    });

    it("requires both documentName and query", async () => {
      const opportunity = await makeOpportunity();
      const result = await executeChatTool("get_document_excerpt", JSON.stringify({ documentName: "RFP.pdf" }), {
        opportunityId: opportunity.id,
        userId: null,
      });
      expect(result).toMatch(/Both documentName and query are required/);
    });

    it("falls back to bounded full text for a not-yet-indexed document, matching by partial filename", async () => {
      const opportunity = await makeOpportunity();
      await db.document.create({
        data: {
          opportunityId: opportunity.id,
          filename: "RFP Final.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          storageKey: "x",
          documentType: "RFP",
          extractionStatus: "COMPLETE",
          extractedText: "The booth must be 10x10 with a locking storage closet.",
        },
      });

      const result = await executeChatTool(
        "get_document_excerpt",
        JSON.stringify({ documentName: "rfp final", query: "booth size" }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toBe("The booth must be 10x10 with a locking storage closet.");
    });

    it("truncates a long not-yet-indexed document's fallback text", async () => {
      const opportunity = await makeOpportunity();
      await db.document.create({
        data: {
          opportunityId: opportunity.id,
          filename: "Big.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          storageKey: "x",
          documentType: "RFP",
          extractionStatus: "COMPLETE",
          extractedText: "x".repeat(10_000),
        },
      });

      const result = await executeChatTool("get_document_excerpt", JSON.stringify({ documentName: "Big.pdf", query: "anything" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toContain("x".repeat(8_000));
      expect(result).not.toContain("x".repeat(8_001));
      expect(result).toContain("truncated");
    });

    it("reports no extracted text for a document that hasn't been analyzed", async () => {
      const opportunity = await makeOpportunity();
      await db.document.create({
        data: {
          opportunityId: opportunity.id,
          filename: "Pending.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          storageKey: "x",
          documentType: "RFP",
          extractionStatus: "PENDING",
        },
      });

      const result = await executeChatTool("get_document_excerpt", JSON.stringify({ documentName: "Pending.pdf", query: "anything" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/no extracted text to search/);
    });

    it("degrades to a plain-text error (never throws) when the document is indexed but OpenAI isn't configured", async () => {
      const opportunity = await makeOpportunity();
      const document = await db.document.create({
        data: {
          opportunityId: opportunity.id,
          filename: "Indexed.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
          storageKey: "x",
          documentType: "RFP",
          extractionStatus: "COMPLETE",
          extractedText: "irrelevant once indexed",
        },
      });
      const zeroVector = `[${"0,".repeat(1535)}0]`;
      await db.$executeRaw`
        INSERT INTO document_chunks (id, "documentId", "opportunityId", "chunkIndex", content, embedding)
        VALUES (${"chunk1"}, ${document.id}, ${opportunity.id}, ${0}, ${"some indexed text"}, ${zeroVector}::vector)
      `;

      const result = await executeChatTool("get_document_excerpt", JSON.stringify({ documentName: "Indexed.pdf", query: "anything" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/That lookup failed/);
    });
  });
});
