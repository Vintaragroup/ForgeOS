import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { createEstimateVersion } from "@/lib/estimate-service";
import {
  commitStandaloneVendorQuoteImport,
  previewStandaloneVendorQuoteImport,
  proposeVendorQuoteLineItems,
} from "@/lib/ai/vendor-quote-service";
import type { VendorQuoteLine } from "@/lib/ai/vendor-match-ai-service";

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

// Same fixture shape as scope-line-item-service.test.ts's
// makeAnalyzedDocument -- a real vendor quote is a PDF, but nothing this
// module does needs real bytes off disk (unlike commitScopeLineItems's
// page-number lookup), so a fake storageKey is fine here too.
async function makeAnalyzedDocument(extractedText: string | null) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "ShowRig quote.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "VENDOR_QUOTE",
      extractionStatus: extractedText ? "COMPLETE" : "PENDING",
      extractedText,
    },
  });
}

describe("proposeVendorQuoteLineItems", () => {
  it("refuses to propose prices for a document that hasn't been analyzed yet, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument(null);

    await expect(proposeVendorQuoteLineItems(document.id, document.opportunityId)).rejects.toThrow(
      /hasn't been analyzed yet/,
    );
  });

  it("throws AiNotConfiguredError for an analyzed document when no API key is set -- .env.test deliberately has none", async () => {
    const document = await makeAnalyzedDocument("CAM-06 Sleeper Floor $840.00");

    await expect(proposeVendorQuoteLineItems(document.id, document.opportunityId)).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });

  // Regression-shaped test for the cross-resource ID authorization gap
  // every other AI-proposal function in this app is guarded against --
  // see the function's own header comment.
  it("rejects a documentId that belongs to a different opportunity, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument("CAM-06 Sleeper Floor $840.00");
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(proposeVendorQuoteLineItems(document.id, otherOpportunity.id)).rejects.toThrow();
  });
});

// Real numbers from the actual Full Swing PGA Orlando booth graphics
// vendor quote (data/RFP/Full_Swing/quote-ExpoCCI-55631-Full_Swing_Booth_
// Graphics-4.pdf, confirmed this session against the live document) --
// the $14,432.88 sign line that had no import path before this feature.
// The real extraction itself can't run in this suite (.env.test
// deliberately has no OpenAI key, same constraint as spreadsheet-line-
// item-service.test.ts's own real-file tests), so these fixture values
// stand in for what a real extraction against that PDF returns; the
// live re-import against the real file is this feature's own
// Verification step, not a unit test.
const FAKE_VENDOR_LINES: VendorQuoteLine[] = [
  {
    description: "46' x 4' Radius Sign -- Dye Sub",
    unit: "EA",
    qty: 1,
    unitPrice: 14432.88,
    totalPrice: 14432.88,
    sourceQuote: "46' x 4'  1  $14,432.88  $14,432.88",
    unitCode: null,
    pageNumber: 1,
  },
  {
    description: "Backwall Graphics Panel",
    unit: "EA",
    qty: 2,
    unitPrice: 500,
    totalPrice: 1000,
    sourceQuote: "Backwall Graphics Panel  2  $500.00  $1,000.00",
    unitCode: "GFX-01",
    pageNumber: 1,
  },
];

describe("previewStandaloneVendorQuoteImport", () => {
  it("throws AiNotConfiguredError before writing anything, for a real un-cached document -- .env.test deliberately has no API key", async () => {
    const document = await makeAnalyzedDocument("46' x 4'  1  $14,432.88  $14,432.88");

    await expect(previewStandaloneVendorQuoteImport(document.id, document.opportunityId)).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );

    const reloaded = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(reloaded.vendorQuoteLineItems).toBeNull();
  });

  it("returns a cached proposal without ever touching the OpenAI client -- proves repeated Preview import clicks don't re-spend tokens", async () => {
    const document = await makeAnalyzedDocument("46' x 4'  1  $14,432.88  $14,432.88");
    await db.document.update({
      where: { id: document.id },
      data: { vendorQuoteLineItems: FAKE_VENDOR_LINES as unknown as Prisma.InputJsonValue },
    });

    const preview = await previewStandaloneVendorQuoteImport(document.id, document.opportunityId);

    expect(preview.kind).toBe("vendor-quote");
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.find((r) => r.unitPrice === 14432.88)?.description).toContain("Radius Sign");
  });

  it("rejects a document that belongs to a different opportunity", async () => {
    const document = await makeAnalyzedDocument("46' x 4'  1  $14,432.88  $14,432.88");
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(previewStandaloneVendorQuoteImport(document.id, otherOpportunity.id)).rejects.toThrow();
  });
});

describe("commitStandaloneVendorQuoteImport", () => {
  it("commits a cached proposal as isDraft LineItems, grouping by unitCode -- rows with no code share one section named after the document", async () => {
    const document = await makeAnalyzedDocument("46' x 4'  1  $14,432.88  $14,432.88");
    await db.document.update({
      where: { id: document.id },
      data: { vendorQuoteLineItems: FAKE_VENDOR_LINES as unknown as Prisma.InputJsonValue },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: document.opportunityId } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitStandaloneVendorQuoteImport(version.id, document.id);

    expect(result.rowsImported).toBe(2);
    expect(result.sectionsCreated).toBe(2);

    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    expect(lineItems).toHaveLength(2);
    expect(lineItems.every((li) => li.isDraft)).toBe(true);

    const signItem = lineItems.find((li) => li.description.includes("Radius Sign"));
    expect(signItem?.unitCost.toNumber()).toBe(14432.88);

    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    expect(sections.map((s) => s.groupLabel).sort()).toEqual([null, "GFX-01"].sort());
    expect(sections.every((s) => s.name === document.filename)).toBe(true);
  });

  it("refuses a second commit of the same document into the same version", async () => {
    const document = await makeAnalyzedDocument("46' x 4'  1  $14,432.88  $14,432.88");
    await db.document.update({
      where: { id: document.id },
      data: { vendorQuoteLineItems: FAKE_VENDOR_LINES as unknown as Prisma.InputJsonValue },
    });
    const estimate = await db.estimate.create({ data: { opportunityId: document.opportunityId } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitStandaloneVendorQuoteImport(version.id, document.id);

    await expect(commitStandaloneVendorQuoteImport(version.id, document.id)).rejects.toThrow(/already been imported/);
  });
});
