import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import type { ProposedLineItem } from "@/lib/ai/scope-line-item-service";
import { buildEstimateFromAllDocuments } from "@/lib/ai/estimate-synthesis-service";

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
});
