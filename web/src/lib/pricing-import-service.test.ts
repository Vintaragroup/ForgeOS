import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { commitPricingImport, previewPricingImport } from "@/lib/pricing-import-service";

// Real fixture from Phase 7's roadmap RFP package -- see data/RFP/superbowl.
// Ground truth (149 rows / 5 categories) independently verified against
// the workbook with openpyxl before writing this test, the same
// "verified against real data" standard as Yoku Moku's total in
// estimate-service.test.ts.
const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx",
);

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

async function makeDocument() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(FIXTURE_PATH);
  const file = new File([bytes], "Exhibit 1 - Financial Proposal Schedule.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const document = await uploadDocument(opportunity.id, { file, documentType: "PRICING_SCHEDULE" });
  return { opportunity, document };
}

describe("previewPricingImport", () => {
  it("parses the real Exhibit 1 pricing schedule into 149 rows across 5 categories", async () => {
    const { document } = await makeDocument();

    const preview = await previewPricingImport(document.id);

    expect(preview.rows).toHaveLength(149);
    expect(preview.categories.sort()).toEqual(
      ["BOOTH_PLATFORM", "CAMERA_PLATFORM", "TemporaryBooth_ADD ON", "TemporaryBooth_BUILD", "TemporaryBooth_SERVICE"].sort(),
    );

    const byCategory = Object.fromEntries(
      preview.categories.map((c) => [c, preview.rows.filter((r) => r.category === c).length]),
    );
    expect(byCategory["TemporaryBooth_BUILD"]).toBe(113);
    expect(byCategory["BOOTH_PLATFORM"]).toBe(30);
    expect(byCategory["CAMERA_PLATFORM"]).toBe(4);

    // Ignores the free-text "add your own item" mini-table further down
    // the sheet (no Category/Qty columns -- not a second pricing table).
    expect(preview.rows.some((r) => r.description === "Description")).toBe(false);

    // Real row 9: a known, human-checked line item.
    const first = preview.rows[0];
    expect(first.description).toContain("Complete Booth Build");
    expect(first.unit).toBe("EA");
    expect(first.qty).toBe(1);
  });

  it("suggests a catalog rate when a row's description confidently matches a real catalog entry", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const { document } = await makeDocument();

    const preview = await previewPricingImport(document.id);
    const doorRow = preview.rows.find((r) => r.description.toLowerCase().includes("compliant door"));

    expect(doorRow).toBeDefined();
    expect(doorRow?.catalogMatch).toEqual({ source: "Rental", name: "Doors", unitCost: 150 });
  });

  it("leaves catalogMatch null for a turnkey line description with no real catalog vocabulary overlap", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const { document } = await makeDocument();

    const preview = await previewPricingImport(document.id);
    const boothBuildRow = preview.rows.find((r) => r.description.includes("Complete Booth Build"));

    expect(boothBuildRow?.catalogMatch).toBeNull();
  });

  it("rejects a document with no recognizable Pricing Schedule sheet", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const file = new File([Buffer.from("not a spreadsheet")], "notes.txt", { type: "text/plain" });
    const document = await uploadDocument(opportunity.id, { file, documentType: "OTHER" });

    await expect(previewPricingImport(document.id)).rejects.toThrow();
  });
});

describe("commitPricingImport", () => {
  it("creates one CATEGORY section per distinct (booth, category) pair, grouping booth-labeled sections under a shared groupLabel", async () => {
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitPricingImport(version.id, document.id);

    // 17 distinct booth/exhibit instances x 2 categories each (Booth
    // Build + Platform), plus 2 booth-independent categories (Add-Ons,
    // Show Services) -- not just 5 flat categories -- see
    // pricing-import-service.ts's groupLabel comment.
    expect(result.sectionsCreated).toBe(36);
    expect(result.rowsImported).toBe(149);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    expect(sections).toHaveLength(36);

    // Real booth's "Item" header cell is richText with mixed run
    // formatting -- a real regression where a naive String(cell.value)
    // stringified it to "[object Object]" instead of its actual text,
    // silently leaving every row's booth grouping off.
    const boothSections = sections.filter((s) => s.groupLabel !== null);
    expect(boothSections).toHaveLength(34);
    expect(new Set(boothSections.map((s) => s.groupLabel)).size).toBe(17);
    const camera203 = boothSections.filter((s) => s.groupLabel === "Section 203 - Camera Booth - Page 2 & 3");
    expect(camera203.map((s) => s.name).sort()).toEqual(["Booth Build", "Platform"]);

    // The two booth-independent categories stay standalone (no groupLabel).
    const standalone = sections.filter((s) => s.groupLabel === null);
    expect(standalone.map((s) => s.name).sort()).toEqual(["Add-Ons & Alternates", "Show Services"]);

    const allLineItems = sections.flatMap((s) => s.lineItems);
    expect(allLineItems).toHaveLength(149);
    expect(allLineItems.every((li) => li.isDraft)).toBe(true);
    expect(allLineItems.every((li) => li.documentId === document.id)).toBe(true);
    // No catalog rows exist in this test's DB state, so every match is
    // null and every unitCost stays at the $0 fallback -- see the
    // dedicated catalog-match test below for the non-empty-catalog case.
    expect(allLineItems.every((li) => li.unitCost.toNumber() === 0)).toBe(true);


    // Drafts are excluded from totals until confirmed -- same gate as
    // the attachmentId-sourced draft flow.
    const refreshedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(refreshedVersion.totalCost.toNumber()).toBe(0);

    // The check-and-balance: every row's sourceQuote is its own real
    // Description cell text, verbatim -- not something derived or
    // guessed, so it's guaranteed to be findable again in the rendered
    // spreadsheet viewer (see document-view-service.ts's findSpreadsheetMatch).
    const complete = allLineItems.find((li) => li.description.includes("Complete Booth Build"));
    expect(complete?.sourceQuote).toContain("Complete Booth Build");
    expect(allLineItems.every((li) => li.sourceQuote && li.sourceQuote.length > 0)).toBe(true);
    expect(allLineItems.every((li) => li.sourcePageNumber === null)).toBe(true); // XLSX has no page concept
  });

  it("seeds unitCost from a confident catalog match instead of leaving it at $0", async () => {
    await db.rentalItem.create({ data: { name: "Doors", unitPrice: 150 } });
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitPricingImport(version.id, document.id);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    const allLineItems = sections.flatMap((s) => s.lineItems);
    const doorItems = allLineItems.filter((li) => li.description.toLowerCase().includes("compliant door"));

    expect(doorItems.length).toBeGreaterThan(0);
    expect(doorItems.every((li) => li.unitCost.toNumber() === 150)).toBe(true);
    // Still isDraft -- a seeded rate doesn't bypass the confirm-before-it-counts gate.
    expect(doorItems.every((li) => li.isDraft)).toBe(true);
  });

  it("refuses a second import of the same document into the same version, rather than duplicating every section and item", async () => {
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitPricingImport(version.id, document.id);
    await expect(commitPricingImport(version.id, document.id)).rejects.toThrow(/already been imported/);

    // The real bug this guards against: a real Super Bowl 2026 estimate
    // had this exact document imported twice before this check existed,
    // doubling all 149 rows to 298.
    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    expect(sections).toHaveLength(36);
    const lineItemCount = await db.lineItem.count({ where: { section: { estimateVersionId: version.id } } });
    expect(lineItemCount).toBe(149);
  });
});
