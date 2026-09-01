import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { addSection, createEstimateVersion, lockEstimateVersion } from "@/lib/estimate-service";
import { executeChatTool } from "@/lib/ai/chat-tools-service";

afterEach(async () => {
  await db.documentChunk.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.lineItem.deleteMany();
  await db.category.deleteMany();
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

  describe("find_section", () => {
    it("reports a matching section, including its exact confirmed/draft item counts", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      await db.lineItem.createMany({
        data: [
          { sectionId: section.id, lineType: "LABOR", description: "A", qty: 1, unitCost: 1, totalCost: 1, isDraft: false },
          { sectionId: section.id, lineType: "LABOR", description: "B", qty: 1, unitCost: 1, totalCost: 1, isDraft: true },
        ],
      });

      const result = await executeChatTool("find_section", JSON.stringify({ name: "Labor" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/"Labor" is a section name -- found, 1 matching section/);
      expect(result).toContain("Labor (Bid Comparison): 2 line item(s) (1 confirmed, 1 draft)");
    });

    it("resolves a combined \"Name (GroupLabel)\" string passed as name, not just a bare section name", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Reception Counter" });

      const result = await executeChatTool("find_section", JSON.stringify({ name: "Labor (Bid Comparison)" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/found, 1 matching section/);
      expect(result).toContain("Labor (Bid Comparison)");
      expect(result).not.toContain("Reception Counter");
    });

    it("reports multiple matching sections separately when the name repeats across booths", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Reception Counter" });
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Sign 5ft4" });

      const result = await executeChatTool("find_section", JSON.stringify({ name: "Labor" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/found, 2 matching section/);
      expect(result).toContain("Reception Counter");
      expect(result).toContain("Sign 5ft4");
    });

    it("reports a real category with zero items as found, not as not-found", async () => {
      const opportunity = await makeOpportunity();
      await db.category.create({ data: { name: "Professional Services", key: "professional-services" } });
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      await createEstimateVersion(estimate.id);

      const result = await executeChatTool("find_section", JSON.stringify({ name: "Professional Services" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/"Professional Services" is a real proposal category -- found, 0 line item\(s\)/);
      expect(result).toContain("no section holds any yet");
    });

    it("reports a real category's item count and which sections hold them, when items exist", async () => {
      const opportunity = await makeOpportunity();
      await db.category.create({ data: { name: "Professional Services", key: "professional-services" } });
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const section = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      await db.lineItem.create({
        data: { sectionId: section.id, lineType: "LABOR", description: "PS item", category: "Professional Services", qty: 1, unitCost: 1, totalCost: 1 },
      });

      const result = await executeChatTool("find_section", JSON.stringify({ name: "Professional Services" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/found, 1 line item\(s\) currently tagged with it, in: Labor \(Bid Comparison\) \(1\)/);
    });

    it("lists every real category and distinct section name when nothing matches", async () => {
      const opportunity = await makeOpportunity();
      await db.category.create({ data: { name: "Structure", key: "structure" } });
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY" });

      const result = await executeChatTool("find_section", JSON.stringify({ name: "Nonexistent" }), {
        opportunityId: opportunity.id,
        userId: null,
      });

      expect(result).toMatch(/Not found/);
      expect(result).toContain("Structure");
      expect(result).toContain("Labor");
    });

    it("requires name", async () => {
      const opportunity = await makeOpportunity();
      const result = await executeChatTool("find_section", "{}", { opportunityId: opportunity.id, userId: null });
      expect(result).toMatch(/name is required/);
    });
  });

  describe("propose_line_item", () => {
    it("creates a draft line item in the named section, and never a confirmed one", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const section = await addSection(version.id, { name: "Rigging", sectionType: "COMPONENT" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Rigging", description: "Motor for truss", lineType: "MATERIAL", qty: 2, unit: "ea", unitCost: 450 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/DRAFT/);
      expect(result).toMatch(/won't count toward any total/);

      const rows = await db.lineItem.findMany({ where: { sectionId: section.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ description: "Motor for truss", isDraft: true, unit: "ea" });
      expect(rows[0].qty.toNumber()).toBe(2);
      expect(rows[0].unitCost.toNumber()).toBe(450);
      expect(rows[0].totalCost.toNumber()).toBe(900);
    });

    it("resolves a combined \"Name (GroupLabel)\" string passed as sectionName -- the exact format the model's own prior tool output displays sections in", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const bidComparisonLabor = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      // A same-named decoy in a different group -- proves the combined
      // string actually disambiguates, not just falls back to "first Labor".
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Reception Counter" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({
          sectionName: "Labor (Bid Comparison)",
          description: "Standard Labor Show Site",
          lineType: "LABOR",
          qty: 2,
          unit: "hrs",
          unitCost: 185,
        }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/DRAFT/);
      const created = await db.lineItem.findFirstOrThrow({ where: { description: "Standard Labor Show Site" } });
      expect(created.sectionId).toBe(bidComparisonLabor.id);
    });

    it("resolves a combined \"Name (GroupLabel)\" string for a totally different section name -- proves this isn't Labor-specific", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const target = await addSection(version.id, { name: "Graphics", sectionType: "CATEGORY", groupLabel: "SS - Lounge Structure" });
      // Decoys: same name in a different group, and a different name
      // entirely in the SAME group -- proves both parts of the pair
      // (name AND groupLabel) are actually being matched, not just one.
      await addSection(version.id, { name: "Graphics", sectionType: "CATEGORY", groupLabel: "FS - Sign 6ft6" });
      await addSection(version.id, { name: "Custom Build", sectionType: "CATEGORY", groupLabel: "SS - Lounge Structure" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({
          sectionName: "Graphics (SS - Lounge Structure)",
          description: "Extra vinyl panel",
          lineType: "MATERIAL",
          qty: 1,
          unit: "ea",
          unitCost: 300,
        }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/DRAFT/);
      const created = await db.lineItem.findFirstOrThrow({ where: { description: "Extra vinyl panel" } });
      expect(created.sectionId).toBe(target.id);
    });

    it("records the real actor on the resulting audit log entry", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Rigging", sectionType: "COMPONENT" });
      const user = await db.user.create({ data: { name: "Estimator", email: `e-${Date.now()}@example.com` } });

      await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Rigging", description: "Motor for truss", lineType: "MATERIAL", qty: 1, unitCost: 450 }),
        { opportunityId: opportunity.id, userId: user.id },
      );

      const log = await db.lineItemAuditLog.findFirstOrThrow({ where: { estimateVersionId: version.id, action: "CREATE" } });
      expect(log.actorId).toBe(user.id);
    });

    it("rejects missing required fields without touching the database", async () => {
      const opportunity = await makeOpportunity();
      const result = await executeChatTool("propose_line_item", JSON.stringify({ sectionName: "Rigging" }), {
        opportunityId: opportunity.id,
        userId: null,
      });
      expect(result).toMatch(/are all required/);
    });

    it("rejects an invalid lineType", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Rigging", sectionType: "COMPONENT" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Rigging", description: "X", lineType: "NOT_REAL", qty: 1, unitCost: 1 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/lineType must be one of/);
    });

    it("lists available sections when the named one doesn't exist", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Rigging", sectionType: "COMPONENT" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Nonexistent Section", description: "X", lineType: "MATERIAL", qty: 1, unitCost: 1 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/No section named "Nonexistent Section"/);
      expect(result).toContain("Rigging");
    });

    it("asks for a specific estimate name when the opportunity has more than one", async () => {
      const opportunity = await makeOpportunity();
      const a = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Booth A" } });
      await createEstimateVersion(a.id);
      const b = await db.estimate.create({ data: { opportunityId: opportunity.id, name: "Booth B" } });
      await createEstimateVersion(b.id);

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Rigging", description: "X", lineType: "MATERIAL", qty: 1, unitCost: 1 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/more than one estimate/);
      expect(result).toContain("Booth A");
      expect(result).toContain("Booth B");
    });

    it("rejects adding to a locked version", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Rigging", sectionType: "COMPONENT" });
      await lockEstimateVersion(version.id);

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Rigging", description: "X", lineType: "MATERIAL", qty: 1, unitCost: 1 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/locked/);

      const rows = await db.lineItem.findMany({ where: { section: { estimateVersionId: version.id } } });
      expect(rows).toHaveLength(0);
    });

    it("asks to disambiguate when the same section name is used across several booths, instead of guessing", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const boothA = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Reception Counter" });
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Sign 3ft10 Qty4" });

      const ambiguous = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Labor", description: "Show site management", lineType: "LABOR", qty: 40, unit: "hrs", unitCost: 65 }),
        { opportunityId: opportunity.id, userId: null },
      );
      expect(ambiguous).toMatch(/More than one section is named "Labor"/);
      expect(ambiguous).toContain("FS - Reception Counter");
      expect(ambiguous).toContain("FS - Sign 3ft10 Qty4");
      expect(await db.lineItem.count()).toBe(0);

      // groupLabel resolves it -- proves the disambiguation param actually works.
      const resolved = await executeChatTool(
        "propose_line_item",
        JSON.stringify({
          sectionName: "Labor",
          groupLabel: "Reception Counter",
          description: "Show site management",
          lineType: "LABOR",
          qty: 40,
          unit: "hrs",
          unitCost: 65,
        }),
        { opportunityId: opportunity.id, userId: null },
      );
      expect(resolved).toMatch(/DRAFT/);
      const created = await db.lineItem.findFirstOrThrow({ where: { description: "Show site management" } });
      expect(created.sectionId).toBe(boothA.id);
    });

    it("flags the likely project-wide option when disambiguating, without silently choosing it or hiding the rest", async () => {
      const opportunity = await makeOpportunity();
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Reception Counter" });
      await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Sign 3ft10 Qty4" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Labor", description: "Production Lead Show Site", lineType: "LABOR", qty: 40, unit: "hrs", unitCost: 185 }),
        { opportunityId: opportunity.id, userId: null },
      );

      // The full, undifferentiated option list is still always present...
      expect(result).toContain("Bid Comparison");
      expect(result).toContain("FS - Reception Counter");
      expect(result).toContain("FS - Sign 3ft10 Qty4");
      // ...plus an explicit, separate hint pointing at the one candidate
      // that doesn't look tied to a specific booth.
      expect(result).toMatch(/project-wide.*most likely fit is: Labor \(Bid Comparison\)/);
      expect(await db.lineItem.count()).toBe(0); // still asks, never guesses
    });

    it("recognizes a real category name passed as sectionName, and reuses the section an existing item of that category already sits in", async () => {
      const opportunity = await makeOpportunity();
      await db.category.create({ data: { name: "Professional Services", key: "professional-services" } });
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const laborSection = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      await db.lineItem.create({
        data: { sectionId: laborSection.id, lineType: "LABOR", description: "Existing PS item", category: "Professional Services", qty: 1, unitCost: 1, totalCost: 1 },
      });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Professional Services", description: "Show site management", lineType: "LABOR", qty: 40, unit: "hrs", unitCost: 65 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/DRAFT/);
      const created = await db.lineItem.findFirstOrThrow({ where: { description: "Show site management" } });
      expect(created.sectionId).toBe(laborSection.id);
      expect(created.category).toBe("Professional Services");
    });

    it("creates a clean standalone section for a real category with no established home yet, rather than forcing it into an unrelated booth section", async () => {
      const opportunity = await makeOpportunity();
      await db.category.create({ data: { name: "Professional Services", key: "professional-services" } });
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      // A real existing section, unrelated to the category being added --
      // proves the new item does NOT get forced in here.
      const receptionLabor = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "FS - Reception Counter" });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Professional Services", description: "Show Site Lead", lineType: "LABOR", qty: 60, unit: "hrs", unitCost: 325 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).toMatch(/DRAFT/);
      expect(result).toMatch(/created new, standalone/);

      const created = await db.lineItem.findFirstOrThrow({ where: { description: "Show Site Lead" } });
      expect(created.category).toBe("Professional Services");
      expect(created.sectionId).not.toBe(receptionLabor.id); // never forced into the unrelated booth section

      const newSection = await db.estimateSection.findUniqueOrThrow({ where: { id: created.sectionId } });
      expect(newSection).toMatchObject({ name: "Professional Services", groupLabel: null, estimateVersionId: version.id });
    });

    it("reuses an already-established section for a category, rather than creating a duplicate section every time", async () => {
      const opportunity = await makeOpportunity();
      await db.category.create({ data: { name: "Professional Services", key: "professional-services" } });
      const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
      const version = await createEstimateVersion(estimate.id);
      const laborSection = await addSection(version.id, { name: "Labor", sectionType: "CATEGORY", groupLabel: "Bid Comparison" });
      await db.lineItem.create({
        data: { sectionId: laborSection.id, lineType: "LABOR", description: "Existing PS item", category: "Professional Services", qty: 1, unitCost: 1, totalCost: 1 },
      });

      const result = await executeChatTool(
        "propose_line_item",
        JSON.stringify({ sectionName: "Professional Services", description: "Show Site Lead", lineType: "LABOR", qty: 60, unit: "hrs", unitCost: 325 }),
        { opportunityId: opportunity.id, userId: null },
      );

      expect(result).not.toMatch(/created new, standalone/);
      const created = await db.lineItem.findFirstOrThrow({ where: { description: "Show Site Lead" } });
      expect(created.sectionId).toBe(laborSection.id);
      expect(await db.estimateSection.count({ where: { estimateVersionId: version.id } })).toBe(1);
    });
  });
});
