import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import {
  COVERAGE_SCHEMA,
  resolveCoverageGaps,
  runScopeCoverageAnalysis,
  type RawCoverageGap,
} from "@/lib/ai/scope-coverage-service";

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

async function makeVersion() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  const version = await createEstimateVersion(estimate.id, 0);
  return { company, opportunity, estimate, version };
}

// mimeType defaults to DOCX, not PDF -- resolveCoverageGaps fetches real
// bytes off disk to compute a page number for a PDF source, which this
// fixture's fake storageKey doesn't have. DOCX has no page concept, so it
// exercises the "no page lookup" path cleanly without needing a real file.
async function makeScopeDocument(
  opportunityId: string,
  extractedText: string | null,
  mimeType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
) {
  return db.document.create({
    data: {
      opportunityId,
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

describe("runScopeCoverageAnalysis", () => {
  it("refuses to run for a version with no analyzed scope documents, before ever touching the OpenAI client", async () => {
    const { version } = await makeVersion();

    await expect(runScopeCoverageAnalysis(version.id)).rejects.toThrow(/No analyzed scope documents/);
  });

  it("throws AiNotConfiguredError once an analyzed scope document exists -- .env.test deliberately has no API key", async () => {
    const { version, opportunity } = await makeVersion();
    await makeScopeDocument(opportunity.id, "Provide booth construction, graphics, and installation labor.");

    await expect(runScopeCoverageAnalysis(version.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("counts a PRICING_SCHEDULE document as a scope document -- a real spreadsheet format neither deterministic importer recognizes can carry real, unimported pricing that coverage analysis needs to see", async () => {
    const { version, opportunity } = await makeVersion();
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Pricing Schedule.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "PRICING_SCHEDULE",
        extractionStatus: "COMPLETE",
        extractedText: "Rigging package -- truss, motors, cabling: $54,993.",
      },
    });

    // Reaches the AiNotConfiguredError guard, not "No analyzed scope
    // documents" -- proves the PRICING_SCHEDULE document was actually
    // picked up, not silently excluded the way it used to be.
    await expect(runScopeCoverageAnalysis(version.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });

  it("counts a DRAWING document as a scope document -- its vision-derived scopeSummary bullets are just as usable as text-extracted ones", async () => {
    const { version, opportunity } = await makeVersion();
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Booth Drawing.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "DRAWING",
        extractionStatus: "COMPLETE",
        extractedSummary: { scopeSummary: [{ text: "6-inch black base", sourceQuote: "", pageNumber: 1 }] },
      },
    });

    // Reaches the AiNotConfiguredError guard, not "No analyzed scope
    // documents" -- proves the DRAWING document was actually picked up.
    await expect(runScopeCoverageAnalysis(version.id)).rejects.toBeInstanceOf(AiNotConfiguredError);
  });
});

describe("resolveCoverageGaps", () => {
  it("drops a gap whose documentFilename doesn't match any document actually sent -- a hallucination guard", async () => {
    const { opportunity } = await makeVersion();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");

    const rawGaps: RawCoverageGap[] = [
      { requirement: "Real gap", sourceQuote: "installation labor", documentFilename: document.filename },
      { requirement: "Hallucinated gap", sourceQuote: "anything", documentFilename: "Nonexistent Document.pdf" },
    ];
    const gaps = await resolveCoverageGaps(rawGaps, [document]);

    expect(gaps).toHaveLength(1);
    expect(gaps[0].requirement).toBe("Real gap");
    expect(gaps[0].documentId).toBe(document.id);
  });

  it("resolves the quote against real extracted text and leaves pageNumber null for a non-PDF source", async () => {
    const { opportunity } = await makeVersion();
    const document = await makeScopeDocument(opportunity.id, "Provide booth construction and installation labor.");

    const gaps = await resolveCoverageGaps(
      [{ requirement: "Installation labor", sourceQuote: "installation labor", documentFilename: document.filename }],
      [document],
    );

    expect(gaps[0].sourceQuote).toBe("installation labor");
    expect(gaps[0].pageNumber).toBeNull();
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

    const { opportunity } = await makeVersion();
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
    const updated = await db.document.findUniqueOrThrow({ where: { id: document.id } });

    const gaps = await resolveCoverageGaps(
      [{ requirement: "Real requirement", sourceQuote: realQuote, documentFilename: "RFP.pdf" }],
      [updated],
    );

    expect(gaps[0].pageNumber).toBe(targetPageIndex + 1);
    expect(gaps[0].sourceQuote).toBe(realQuote);
  });
});

describe("COVERAGE_SCHEMA", () => {
  it("is a strict JSON schema with every gap field required -- proves the shape is actually wired into the request, not just documented in the type", () => {
    expect(COVERAGE_SCHEMA.strict).toBe(true);
    expect(COVERAGE_SCHEMA.schema.properties.gaps.items.required).toEqual([
      "requirement",
      "sourceQuote",
      "documentFilename",
    ]);
    expect(COVERAGE_SCHEMA.schema.properties.gaps.items.additionalProperties).toBe(false);
  });
});
