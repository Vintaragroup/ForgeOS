import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { commitScopeLineItems, proposeLineItemsFromScope, type ProposedLineItem } from "@/lib/ai/scope-line-item-service";

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.rentalItem.deleteMany();
  await db.material.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// mimeType defaults to DOCX, not PDF -- commitScopeLineItems fetches real
// bytes off disk to compute a page number for a PDF source (see
// text-extraction.ts's extractPdfPageTexts), which this fixture's fake
// storageKey doesn't have. DOCX has no page concept, so it exercises the
// "no page lookup" path cleanly without needing a real file on disk.
async function makeAnalyzedDocument(extractedText: string | null, mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "Scope of Work.docx",
      mimeType,
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "SCOPE_OF_WORK",
      extractionStatus: extractedText ? "COMPLETE" : "PENDING",
      extractedText,
    },
  });
}

describe("proposeLineItemsFromScope", () => {
  it("refuses to propose items for a document that hasn't been analyzed yet, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument(null);

    await expect(proposeLineItemsFromScope(document.id)).rejects.toThrow(/hasn't been analyzed yet/);
  });

  it("throws AiNotConfiguredError for an analyzed document when no API key is set -- .env.test deliberately has none", async () => {
    const document = await makeAnalyzedDocument("Provide booth construction, graphics, and installation labor.");

    await expect(proposeLineItemsFromScope(document.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("commitScopeLineItems", () => {
  it("refuses to commit when no items have been proposed yet", async () => {
    const document = await makeAnalyzedDocument("some scope text");
    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await expect(commitScopeLineItems(version.id, document.id)).rejects.toThrow(/Propose items first/);
  });

  it("groups proposed items into sections by category, seeds a catalog-matched rate, and flags an inferred quantity in the description", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const document = await makeAnalyzedDocument("some scope text");

    const proposed: ProposedLineItem[] = [
      {
        description: "36 x 84 Compliant Door",
        qty: 2,
        qtyIsExplicit: true,
        unit: "EA",
        lineType: "MATERIAL",
        category: "Booth Structure",
        sourceQuote: "some scope text",
      },
      {
        description: "Installation labor",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "LABOR",
        category: "Labor",
        sourceQuote: "some scope text",
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const opportunity = await db.opportunity.findFirstOrThrow();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitScopeLineItems(version.id, document.id);
    expect(result.sectionsCreated).toBe(2);
    expect(result.rowsImported).toBe(2);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    const allLineItems = sections.flatMap((s) => s.lineItems);
    expect(allLineItems).toHaveLength(2);
    expect(allLineItems.every((li) => li.isDraft)).toBe(true);

    const doorItem = allLineItems.find((li) => li.description.includes("Compliant Door"));
    expect(doorItem?.unitCost.toNumber()).toBe(150); // catalog-matched
    expect(doorItem?.description).not.toContain("qty estimated");

    const laborItem = allLineItems.find((li) => li.description.includes("Installation labor"));
    expect(laborItem?.unitCost.toNumber()).toBe(0); // no catalog match
    expect(laborItem?.description).toContain("(qty estimated -- verify)");

    // The check-and-balance: every committed row carries the exact quote
    // it came from, so a reviewer can click through and verify it -- for
    // a DOCX source there's no page concept, so sourcePageNumber stays
    // null and the viewer falls back to a text-search highlight instead.
    expect(allLineItems.every((li) => li.sourceQuote === "some scope text")).toBe(true);
    expect(allLineItems.every((li) => li.sourcePageNumber === null)).toBe(true);
  });

  it("computes a real page number for a PDF source, from the PDF's own per-page text", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const { uploadDocument } = await import("@/lib/document-service");
    const { extractPdfPageTexts } = await import("@/lib/ai/text-extraction");

    const rfpDir = path.resolve(
      import.meta.dirname,
      "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build",
    );
    const bytes = await readFile(path.join(rfpDir, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));

    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const file = new File([bytes], "RFP.pdf", { type: "application/pdf" });
    const document = await uploadDocument(opportunity.id, { file, documentType: "SCOPE_OF_WORK" });

    // A real, known substring pulled from a specific real page -- proves
    // the lookup finds the ACTUAL page, not just any non-null number.
    const pages = await extractPdfPageTexts(bytes);
    const targetPageIndex = 3;
    const realQuote = pages[targetPageIndex].slice(40, 90).trim();
    expect(realQuote.length).toBeGreaterThan(20);

    await db.document.update({
      where: { id: document.id },
      data: { extractionStatus: "COMPLETE", extractedText: pages.join("\n") },
    });

    const proposed: ProposedLineItem[] = [
      {
        description: "Real scope item",
        qty: 1,
        qtyIsExplicit: false,
        unit: "LOT",
        lineType: "MATERIAL",
        category: "Test Category",
        sourceQuote: realQuote,
      },
    ];
    await db.document.update({
      where: { id: document.id },
      data: { proposedLineItems: proposed as unknown as Prisma.InputJsonValue },
    });

    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    await commitScopeLineItems(version.id, document.id);

    const lineItem = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id } });
    expect(lineItem.sourcePageNumber).toBe(targetPageIndex + 1);
    expect(lineItem.sourceQuote).toBe(realQuote);
  });
});
