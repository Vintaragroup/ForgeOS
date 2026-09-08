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

// A real, structurally distinct Design Cost Estimate booth workbook --
// same fixture design-cost-estimate-import-service.test.ts's own Section
// 211 coverage uses. Needed as a stand-in "real vendor workbook" in
// tests below: reusing CLIENT_TEMPLATE_PATH's own bytes for that would
// make findClientPricingTemplateSheet misdetect the stand-in AS the
// client template it's supposed to be distinct from -- confirmed live
// that even Arena-template.xlsx (a different real fixture) still matches
// that same detector, since it's the blank version of the identical
// client-provided template Exhibit 1 fills in. A Design Cost Estimate
// workbook has no Category/Description/Unit/Qty flat header at all, so
// it can't collide with that detector the way any flat-schedule-shaped
// file does.
const VENDOR_WORKBOOK_PATH = path.resolve(
  import.meta.dirname,
  "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/Archive/SUPER BOWL A 6.3.0 SECTION 211 - Estimate - A.6.3.0.xlsx",
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
  await db.lineItemAuditLog.deleteMany();
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

  // A document that already has SOME committed line items is no longer
  // hard-skipped outright (the old behavior) -- it's re-processed through
  // commitScopeLineItems like any other, whose own fresh Tier 1 recompute
  // silently excludes whatever's an exact duplicate of what's already
  // there. This is the real recovery scenario duplicate detection exists
  // for: re-running "Build from all documents" now safely picks up any
  // genuinely missing items instead of refusing to touch an
  // already-partially-committed document at all.
  it("commits an already-proposed scope document without re-proposing, and re-processes (with zero rows landing) a document whose cached proposal is an exact duplicate of what's already committed", async () => {
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
    // A cached proposal exactly matching what's already committed --
    // proves this document is genuinely re-processed (not blindly
    // re-inserted, not hard-skipped) with no OpenAI call needed, since
    // the cache means proposeFn is never invoked and Tier 1 alone
    // resolves the duplicate.
    const alreadyProposed: ProposedLineItem[] = [
      {
        description: "Already-imported row",
        qty: 1,
        qtyIsExplicit: true,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Booth Structure & Walls",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: alreadyCommittedDoc.id },
      data: { proposedLineItems: alreadyProposed as unknown as Prisma.InputJsonValue },
    });

    const result = await buildEstimateFromAllDocuments(version.id, opportunity.id, null);

    expect(result.imported).toEqual([
      { filename: "RFP.docx", kind: "scope", rowsImported: 1 },
      { filename: "Already committed.docx", kind: "scope", rowsImported: 0 },
    ]);
    expect(result.skipped).toEqual([]);

    const committedLineItem = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id } });
    expect(committedLineItem.description).toBe("Booth structure fabrication (qty estimated -- verify)");

    // Tier 1 excluded the duplicate -- the pre-existing row is still the
    // only one for this document, nothing was re-inserted.
    const alreadyCommittedRows = await db.lineItem.count({ where: { documentId: alreadyCommittedDoc.id } });
    expect(alreadyCommittedRows).toBe(1);
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

    // Needs REAL, parseable bytes now (not just a seeded LineItem against a
    // fake storageKey) -- the pricingDocs loop below no longer hard-skips a
    // document just because it already contributed a line item, so it will
    // genuinely try to re-commit this one via commitPricingImport, which
    // reads the document's real bytes. Reuses the same client-template
    // fixture makeClientTemplateDocument uploads elsewhere in this file,
    // just under the filename this test needs (the committedPricingStems
    // check below only cares about the filename stem matching the drawing,
    // not this file's real content).
    const pricingBytes = await readFile(CLIENT_TEMPLATE_PATH);
    const pricingDoc = await uploadDocument(opportunity.id, {
      file: new File([pricingBytes], "SUPER BOWL A 6.8.2 SECTION 428.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      documentType: "PRICING_SCHEDULE",
    });
    // A real LineItem already exists for this document -- this is what
    // committedPricingStems' own alreadyCommitted() check reads to decide
    // this pricing schedule already covers the matching drawing's scope.
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

    // The pricing schedule itself is genuinely re-processed now (no longer
    // hard-skipped) -- its own real rows don't match the one fake seeded
    // LineItem's description, so they land as new, unrelated to this
    // test's own assertion (the drawing skip below).
    expect(result.imported).toEqual([
      { filename: "SUPER BOWL A 6.8.2 SECTION 428.xlsx", kind: "pricing", rowsImported: expect.any(Number) },
    ]);
    expect(result.skipped).toEqual([
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
    // the hasGranularVendorSource check just above reads this seeded
    // row's own positionCode directly (never re-parses this document's
    // real bytes to make THAT determination), but the pricingDocs loop
    // below no longer hard-skips a document just because it already
    // contributed a line item, so it needs real, parseable (and
    // non-client-template-shaped -- see ARENA_TEMPLATE_PATH's own
    // comment) bytes to survive being genuinely re-processed.
    const vendorBytes = await readFile(VENDOR_WORKBOOK_PATH);
    const vendorDoc = await uploadDocument(opportunity.id, {
      file: new File([vendorBytes], "SUPER BOWL A 6.3.0 SECTION 203.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      documentType: "PRICING_SCHEDULE",
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

    // vendorDoc is genuinely re-processed now (no longer hard-skipped) --
    // its own real rows don't match the one fake seeded LineItem's
    // description, so they land as new, unrelated to this test's own
    // assertion (the client-template skip below).
    expect(result.imported).toEqual([
      { filename: "SUPER BOWL A 6.3.0 SECTION 203.xlsx", kind: "pricing", rowsImported: expect.any(Number) },
    ]);
    expect(result.skipped).toEqual([
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
