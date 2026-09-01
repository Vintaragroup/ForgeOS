import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import type { ProposedLineItem } from "@/lib/ai/scope-line-item-service";
import { buildEstimateFromAllDocuments } from "@/lib/ai/estimate-synthesis-service";

// Real fixture: the client's own bid-comparison template -- confirmed live
// to resolve to kind "pricing-schedule" (a real, deterministic parse, not
// an AI fallback) via pricing-import-service.ts's own flat-schedule
// detector, which is exactly why the skip below can't be unconditional.
const CLIENT_TEMPLATE_PATH = path.resolve(
  import.meta.dirname,
  "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx",
);

async function makeClientTemplateDocument(opportunityId: string) {
  const bytes = await readFile(CLIENT_TEMPLATE_PATH);
  const file = new File([bytes], "Exhibit 1.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  return uploadDocument(opportunityId, { file, documentType: "PRICING_SCHEDULE" });
}

afterEach(async () => {
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

describe("buildEstimateFromAllDocuments", () => {
  it("skips a not-yet-analyzed document without touching anything else, and reports why", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Schedule A.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "SCOPE_OF_WORK",
        extractionStatus: "PENDING",
      },
    });

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/Not analyzed yet/);
  });

  it("commits an already-proposed scope document without re-proposing, and skips a document already committed", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "RFP.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
        extractedText: "Provide booth structure and installation labor.",
      },
    });
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth structure fabrication",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "Provide booth structure and installation labor.",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const alreadyCommittedDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Already committed.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key-2",
        documentType: "SCOPE_OF_WORK",
        extractionStatus: "COMPLETE",
        extractedText: "some scope text",
      },
    });
    const existingSection = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Existing", sectionType: "CATEGORY", sortOrder: 0 },
    });
    await db.lineItem.create({
      data: {
        sectionId: existingSection.id,
        lineType: "MATERIAL",
        description: "Already-imported row",
        qty: 1,
        unitCost: 0,
        totalCost: 0,
        documentId: alreadyCommittedDoc.id,
        isDraft: true,
      },
    });

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toEqual([{ filename: "RFP.docx", kind: "scope", rowsImported: 1 }]);
    expect(result.skipped).toEqual([{ filename: "Already committed.docx", reason: "Already imported into this estimate." }]);

    const committedLineItem = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id } });
    expect(committedLineItem.description).toBe("Booth structure fabrication (qty estimated -- verify)");
  });

  it("merges two documents that both propose items under the same category into one shared section, not two", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const makeProposedDoc = async (filename: string, description: string) => {
      const document = await db.document.create({
        data: {
          opportunityId: opportunity.id,
          filename,
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: 100,
          storageKey: `key-${filename}`,
          documentType: "RFP",
          extractionStatus: "COMPLETE",
          extractedText: "some scope text",
        },
      });
      const proposed: ProposedLineItem[] = [
        {
          description,
          qty: 1,
          qtyIsExplicit: false,
          unit: "LOT",
          lineType: "MATERIAL",
          category: "Other",
          sourceQuote: "some scope text",
        },
      ];
      await db.document.update({
        where: { id: document.id },
        data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
      });
      return document;
    };

    await makeProposedDoc("Doc A.docx", "Item from doc A");
    await makeProposedDoc("Doc B.docx", "Item from doc B");

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);
    expect(result.imported).toHaveLength(2);

    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id, name: "Other" } });
    expect(sections).toHaveLength(1);

    const lineItems = await db.lineItem.findMany({ where: { sectionId: sections[0].id } });
    expect(lineItems).toHaveLength(2);
  });

  it("commits an already-proposed DRAWING document via the vision-sourced path, without calling the text-based proposer", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    // No extractedText at all -- a drawing never has one. Pre-caching
    // proposedLineItems (as proposeLineItemsFromDrawing would) proves the
    // drawingDocs loop reuses the cache and never needs
    // proposeLineItemsFromScope's extractedText requirement. mimeType is
    // deliberately NOT PDF_MIME -- same reason as makeAnalyzedDocument's
    // own comment above: a real PDF mime would make commitScopeLineItems
    // fetch real bytes off disk for page-text lookup, which this
    // fixture's fake storageKey doesn't have. Irrelevant here anyway --
    // this item's page number comes from the model-reported pageNumber
    // bypass, not a PDF text search.
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Rendering.pdf",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
      },
    });
    const proposed: ProposedLineItem[] = [
      {
        description: "Booth structure fabrication",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "",
        pageNumber: 1,
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toEqual([{ filename: "Rendering.pdf", kind: "drawing", rowsImported: 1 }]);
    const committedLineItem = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id } });
    expect(committedLineItem.sourcePageNumber).toBe(1);
  });

  it("skips a DRAWING whose matching Pricing Schedule (same filename stem) is already committed, instead of duplicating its scope with a zero-cost AI summary", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    // Stands in for a real commitPricingImport run -- alreadyCommitted only
    // checks for an existing LineItem against this documentId, so a
    // manually-seeded row is equivalent and avoids needing a real xlsx
    // fixture here, same shortcut the "already committed" test above uses.
    const pricingDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "SUPER BOWL A 6.8.2 SECTION 428.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key-xlsx",
        documentType: "PRICING_SCHEDULE",
        extractionStatus: "COMPLETE",
      },
    });
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY", sortOrder: 0 },
    });
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "606 0310 0434 -- 1/3M X 1/2M FRAME",
        qty: 1,
        unitCost: 195,
        totalCost: 195,
        documentId: pricingDoc.id,
      },
    });

    const drawingDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "SUPER BOWL A 6.8.2 SECTION 428.pdf",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        sizeBytes: 100,
        storageKey: "test-key-pdf",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
      },
    });
    const proposed: ProposedLineItem[] = [
      {
        description: "Complete Booth Build",
        qty: 1,
        qtyIsExplicit: false,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "",
        pageNumber: 1,
      },
    ];
    await db.document.update({
      where: { id: drawingDoc.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toHaveLength(0);
    expect(result.skipped).toEqual([
      // The seeded-already-committed xlsx itself, via the ordinary
      // pricingDocs loop -- unrelated to this test's own assertion, just
      // the existing "already imported" behavior firing as normal.
      { filename: "SUPER BOWL A 6.8.2 SECTION 428.xlsx", reason: "Already imported into this estimate." },
      {
        filename: "SUPER BOWL A 6.8.2 SECTION 428.pdf",
        reason:
          "A pricing schedule/vendor quote with the same name is already imported -- that already covers this drawing's scope with real pricing.",
      },
    ]);
    const drawingLineItem = await db.lineItem.findFirst({ where: { documentId: drawingDoc.id } });
    expect(drawingLineItem).toBeNull();
  });

  it("imports a client-template-shaped document normally when it's the only pricing source for the job", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    const clientTemplateDoc = await makeClientTemplateDocument(opportunity.id);

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toEqual([{ filename: "Exhibit 1.xlsx", kind: "pricing", rowsImported: expect.any(Number) }]);
    const committed = await db.lineItem.count({ where: { documentId: clientTemplateDoc.id } });
    expect(committed).toBeGreaterThan(0);
  });

  it("skips a client-template-shaped document once real granular vendor data already exists for this job", async () => {
    const opportunity = await makeOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    // Stands in for a real, already-committed per-booth vendor workbook --
    // buildProposals/the skip check here only reads positionCode, so a
    // seeded row is equivalent to a real commitDesignCostEstimateImport
    // run, same shortcut this file's other tests already use.
    const vendorDoc = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "SUPER BOWL A 6.3.0 SECTION 203.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key-vendor",
        documentType: "PRICING_SCHEDULE",
      },
    });
    const section = await db.estimateSection.create({
      data: { estimateVersionId: version.id, name: "Structure", sectionType: "CATEGORY", sortOrder: 0 },
    });
    await db.lineItem.create({
      data: {
        sectionId: section.id,
        lineType: "MATERIAL",
        description: "1/3M X 1/2M FRAME",
        qty: 1,
        unitCost: 195,
        totalCost: 195,
        documentId: vendorDoc.id,
        positionCode: "606 0310 0434",
      },
    });

    const clientTemplateDoc = await makeClientTemplateDocument(opportunity.id);
    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toHaveLength(0);
    expect(result.skipped).toEqual([
      // vendorDoc itself, via the ordinary "already has a committed row"
      // check -- unrelated to this test's own assertion, since it stands
      // in for a real already-imported vendor workbook.
      { filename: "SUPER BOWL A 6.3.0 SECTION 203.xlsx", reason: "Already imported into this estimate." },
      {
        filename: "Exhibit 1.xlsx",
        reason:
          "This is the client's own bid-comparison template, and a real vendor workbook already covers this job's scope in more detail -- use Reconcile Against Client Template instead of importing it as line items.",
      },
    ]);
    const committed = await db.lineItem.count({ where: { documentId: clientTemplateDoc.id } });
    expect(committed).toBe(0);
  });
});
