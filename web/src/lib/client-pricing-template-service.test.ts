import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import { commitDesignCostEstimateImport } from "@/lib/design-cost-estimate-import-service";
import {
  findClientPricingTemplateSheet,
  parseClientPricingTemplate,
  reconcileAgainstClientTemplate,
} from "@/lib/client-pricing-template-service";

// Same real fixture pricing-import-service.test.ts already uses as its
// primary flat-schedule fixture (ground-truth verified there: 162 rows /
// 5 categories via the OLD flat importer, which is the correct, intended
// way to import this file's rows as our own line items to price by hand).
// This file's own new parser is a SEPARATE, read-only reading of the same
// document for a different purpose -- comparing it against an estimate
// that was priced from vendor-engineered booth workbooks instead, never
// importing it as line items itself, so the two coexist without conflict.
const EXHIBIT_1_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Exhibit 1 - SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx",
);
const SECTION_211_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/SUPER BOWL A 6.3.0 SECTION 211 - Estimate - A.6.3.0.xlsx",
);

async function loadWorkbook(filePath: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(filePath)) as unknown as ArrayBuffer);
  return wb;
}

async function makeDocumentFrom(filePath: string, filename: string, opportunityId?: string) {
  let opportunity;
  if (opportunityId) {
    opportunity = await db.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
  } else {
    const company = await db.company.create({ data: { name: "Test Co" } });
    opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  }
  const bytes = await readFile(filePath);
  const file = new File([bytes], filename, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const document = await uploadDocument(opportunity.id, { file, documentType: "PRICING_SCHEDULE" });
  return { opportunity, document };
}

afterEach(async () => {
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.category.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("detectClientPricingTemplateSheet", () => {
  it("fires on the real Exhibit 1 client template", async () => {
    const wb = await loadWorkbook(EXHIBIT_1_PATH);
    expect(findClientPricingTemplateSheet(wb)).not.toBeNull();
  });

  it("does not fire on a Design Cost Estimate booth workbook (a different real shape)", async () => {
    const wb = await loadWorkbook(SECTION_211_PATH);
    expect(findClientPricingTemplateSheet(wb)).toBeNull();
  });
});

describe("parseClientPricingTemplate", () => {
  it("parses every real booth Section with its real line-item count and stops before VARIATIONS", async () => {
    const wb = await loadWorkbook(EXHIBIT_1_PATH);
    const sheet = findClientPricingTemplateSheet(wb)!;
    const rows = parseClientPricingTemplate(sheet);

    const bySection = new Map<string, number>();
    for (const row of rows) {
      if (row.isAddOn || !row.section) continue;
      bySection.set(row.section, (bySection.get(row.section) ?? 0) + 1);
    }

    // Ground truth read directly off the real file's own Section blocks.
    expect(Object.fromEntries(bySection)).toEqual({
      "SECTION 203": 16,
      "SECTION 211": 16,
      "SECTION 231": 9,
      "SECTION 315": 9,
      "SECTION 330": 9,
      "SECTION 332": 17,
      "SECTION 333": 9,
      "SECTION 402": 17,
      "SECTION 403": 9,
      "SECTION 428": 9,
      "SECTION 429": 9,
      "SECTION 430": 9,
      "SECTION 401": 9,
    });

    // The free-form "add your own item" VARIATIONS block below the Total
    // row has no fixed shape -- confirms it never leaks in as a row.
    expect(rows.some((r) => r.description === "Description")).toBe(false);
  });

  it("parses the standalone ADD ONS / RATE CARD block as isAddOn rows with no Section", async () => {
    const wb = await loadWorkbook(EXHIBIT_1_PATH);
    const sheet = findClientPricingTemplateSheet(wb)!;
    const rows = parseClientPricingTemplate(sheet);

    const addOnRows = rows.filter((r) => r.isAddOn);
    expect(addOnRows.length).toBeGreaterThan(0);
    expect(addOnRows.every((r) => r.section === null)).toBe(true);
    expect(addOnRows.some((r) => r.description === "Rex-Frame temporary wall system")).toBe(true);
  });
});

describe("reconcileAgainstClientTemplate", () => {
  it("matches a committed booth Section by its groupLabel, flags an un-imported Section as missing, and flags the real flooring gap", async () => {
    const { opportunity, document: section211Doc } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");
    await db.category.createMany({
      data: [
        { name: "Structure", key: "structure" },
        { name: "Accessories", key: "accessories" },
        { name: "Graphics", key: "graphics" },
        { name: "Labor", key: "labor" },
        { name: "Shipping", key: "shipping" },
        { name: "Flooring", key: "flooring" },
      ],
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    await commitDesignCostEstimateImport(version.id, section211Doc.id);

    const { document: exhibit1Doc } = await makeDocumentFrom(EXHIBIT_1_PATH, "Exhibit 1.xlsx", opportunity.id);

    const result = await reconcileAgainstClientTemplate(version.id, exhibit1Doc.id);

    const section211 = result.sections.find((s) => s.section === "SECTION 211");
    expect(section211).toBeDefined();
    expect(section211?.missingSection).toBe(false);
    expect(section211?.ourItemCount).toBeGreaterThan(0);
    expect(section211?.ourTotal.toNumber()).toBeGreaterThan(0);
    expect(section211?.clientItems.length).toBe(16);
    // The vendor's booth-build workbook has no Flooring-category items at
    // all (confirmed against the real file -- BeMatrix/Wall Panels/
    // Graphic Panels/Labor/Transportation only) while the client's own
    // Section 211 block expects FR Carpet, a water-permeable roof, a
    // platform, and a sleeper floor -- a real, correct gap.
    expect(section211?.categoryGaps.some((g) => g.includes("flooring"))).toBe(true);

    const section401 = result.sections.find((s) => s.section === "SECTION 401");
    expect(section401).toBeDefined();
    expect(section401?.missingSection).toBe(true);
    expect(section401?.ourItemCount).toBe(0);

    expect(result.addOnRows.length).toBeGreaterThan(0);
  });

  it("rejects a document that isn't the client template shape", async () => {
    const { opportunity, document: section211Doc } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await expect(reconcileAgainstClientTemplate(version.id, section211Doc.id)).rejects.toThrow(
      /doesn't look like the client's RFP pricing template/,
    );
  });
});
