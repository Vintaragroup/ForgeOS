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

  it("rejects a document with no recognizable Pricing Schedule sheet", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
    const file = new File([Buffer.from("not a spreadsheet")], "notes.txt", { type: "text/plain" });
    const document = await uploadDocument(opportunity.id, { file, documentType: "OTHER" });

    await expect(previewPricingImport(document.id)).rejects.toThrow();
  });
});

describe("commitPricingImport", () => {
  it("creates one CATEGORY section per distinct category with isDraft line items summing to the right count", async () => {
    const { opportunity, document } = await makeDocument();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitPricingImport(version.id, document.id);

    expect(result.sectionsCreated).toBe(5);
    expect(result.rowsImported).toBe(149);

    const sections = await db.estimateSection.findMany({
      where: { estimateVersionId: version.id },
      include: { lineItems: true },
    });
    expect(sections).toHaveLength(5);

    const allLineItems = sections.flatMap((s) => s.lineItems);
    expect(allLineItems).toHaveLength(149);
    expect(allLineItems.every((li) => li.isDraft)).toBe(true);
    expect(allLineItems.every((li) => li.documentId === document.id)).toBe(true);
    expect(allLineItems.every((li) => li.unitCost.toNumber() === 0)).toBe(true);

    // Drafts are excluded from totals until confirmed -- same gate as
    // the attachmentId-sourced draft flow.
    const refreshedVersion = await db.estimateVersion.findUniqueOrThrow({ where: { id: version.id } });
    expect(refreshedVersion.totalCost.toNumber()).toBe(0);
  });
});
