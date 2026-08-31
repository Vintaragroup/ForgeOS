import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import {
  commitDesignCostEstimateImport,
  previewDesignCostEstimateImport,
  readDesignCostRowsForReconciliation,
} from "@/lib/design-cost-estimate-import-service";
import { previewPricingImport } from "@/lib/pricing-import-service";

// Real fixtures from data/RFP/superbowl/RFP006 - Temporary Booth Build/
// Vendor-pricing-engineering/ -- 13 real per-booth "DESIGN COST ESTIMATE"
// workbooks, confirmed live (openpyxl + a raw ExcelJS dump of the actual
// formulas, not filename guessing) to share one internal template shape
// but differ in one important way: Section 211 computes cleanly end to
// end, Section 203 has several #VALUE!/#DIV/0! cells cascading from a
// blank Sq. Ft. cell on ~7 Graphic Panels rows into its own grand total.
// Both are used here specifically because that difference is exactly
// what this parser needs to survive -- it never reads the sheet's own
// Total Cost/Retail/subtotal cells, only the raw Qty/Unit Cost/Sq. Ft.
// inputs, which stay valid in both files.
// These 4 now live under this folder's own Archive/ subfolder -- a real
// reorganization that happened after this test was first written (a
// sibling, differently-named set now lives directly under quotes/ instead,
// used by cad-reconciliation-service.test.ts/cad-pull-sheet-service.test.ts).
const SECTION_211_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/Archive/SUPER BOWL A 6.3.0 SECTION 211 - Estimate - A.6.3.0.xlsx",
);
const SECTION_203_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/Archive/SUPER BOWL A 6.3.0 SECTION 203 2027 - Estimate - A.6.3.0.xlsx",
);
// Section 429 and 430 are a confirmed byte-identical mirror pair -- both
// literally carry "A6.8.0 SECTION 329" as their own internal Build Name
// (a booth not even present in this folder), copied wholesale rather than
// independently priced.
const SECTION_429_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/Archive/SUPER BOWL A 6.8.0 SECTION 429 - Estimate - A6.8.0 SECTION 329.xlsx",
);
const SECTION_430_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/Archive/SUPER BOWL A 6.8.0 SECTION 430 - Estimate - A6.8.0 SECTION 329.xlsx",
);
// The CURRENT quote for Section 203 (distinct from the archived
// SECTION_203_PATH above) -- this is the file cad-pull-sheet-service.ts's
// own Section 203 CAD fixture actually corresponds to, confirmed live:
// its Part Numbers and Sq. Ft. values match that CAD Pull Sheet exactly.
const CURRENT_SECTION_203_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/quotes/SUPER BOWL A 6.3.0 SECTION 203.xlsx",
);

async function makeDocumentFrom(filePath: string, filename: string) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
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

describe("previewPricingImport dispatch", () => {
  it("recognizes a Design Cost Estimate booth workbook and delegates to the new parser, not the flat-schedule one", async () => {
    const { opportunity, document } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");

    const preview = await previewPricingImport(document.id, opportunity.id);

    expect(preview.kind).toBe("design-cost-estimate");
  });
});

describe("previewDesignCostEstimateImport", () => {
  it("parses Section 211 (a clean file) and recomputes totals matching the real workbook's own hand-verified numbers", async () => {
    const { opportunity, document } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");

    const preview = await previewDesignCostEstimateImport(document.id, opportunity.id);

    expect(preview.buildName).toBe("A.6.3.0");
    expect(preview.rows.length).toBeGreaterThan(0);

    // Real row 41 (BeMatrix frame, no Sq. Ft. factor): qty 3 x $325 = $975.
    const frameRow = preview.rows.find((r) => r.description.includes("2418mm x 310mm Frame"));
    expect(frameRow).toBeDefined();
    expect(frameRow?.qty).toBe(3);
    expect(frameRow?.unitCost).toBeCloseTo(325, 2);

    // Real row 81 (Wall Panel, Sq. Ft. DOES factor into the total): the
    // sheet's own formula is qty * sqFt * unitCost = 7 * 0.9 * 1.12 =
    // 7.056 total -- this parser folds the Sq. Ft. factor into unitCost
    // (this app's own LineItem total is always qty * unitCost, no
    // separate multiplier), so unitCost here should be 1.12 * 0.9, not
    // the raw $1.12/sq.ft. rate.
    const panelRow = preview.rows.find((r) => r.qty === 7 && Math.abs(r.unitCost - 1.12 * 0.9) < 0.01);
    expect(panelRow).toBeDefined();

    // Real row 110 (Labor/Warehouse) has a BLANK Description cell but a
    // real Type value ("Warehouse") -- must fall back to it, same
    // item-or-description convention pricing-import-service.ts already
    // established, or this row would be wrongly dropped as a spacer.
    const laborRow = preview.rows.find((r) => r.description === "Warehouse");
    expect(laborRow).toBeDefined();
    expect(laborRow?.qty).toBe(5.9);
    expect(laborRow?.unitCost).toBeCloseTo(106.5, 2);
  });

  it("parses Section 203 successfully despite its own #VALUE!/#DIV/0! cells, by never trusting the sheet's derived totals", async () => {
    const { opportunity, document } = await makeDocumentFrom(SECTION_203_PATH, "Section 203.xlsx");

    const preview = await previewDesignCostEstimateImport(document.id, opportunity.id);

    expect(preview.buildName).toBe("A.6.3.0");
    expect(preview.rows.length).toBeGreaterThan(0);
    // None of the recomputed rows should carry the sheet's own broken
    // string error through -- every unitCost/qty must be a real number.
    for (const row of preview.rows) {
      expect(Number.isFinite(row.qty)).toBe(true);
      expect(Number.isFinite(row.unitCost)).toBe(true);
    }

    // The specific broken row (blank Sq. Ft. on an AV/Graphic Panels item,
    // qty 6, $0 unit cost in the source) -- its sheet cell is #VALUE!, but
    // this parser reads the raw qty/unitCost inputs directly and never
    // touches the broken Total Cost formula at all, so it should resolve
    // to a clean $0, not an error or NaN.
    const brokenRow = preview.rows.find((r) => r.description.includes("Track for Plexi Glass") && r.qty === 6);
    expect(brokenRow).toBeDefined();
    expect(brokenRow?.unitCost).toBe(0);
  });

  it("captures a real hardware Part Number, and leaves it null for a category-label row that only looks like one", async () => {
    const { opportunity, document } = await makeDocumentFrom(CURRENT_SECTION_203_PATH, "Section 203 current.xlsx");

    const preview = await previewDesignCostEstimateImport(document.id, opportunity.id);

    const frame = preview.rows.find((r) => r.description === "1/3M X 1/2M FRAME");
    expect(frame?.partNumber).toBe("606 0310 0434");

    const misc = preview.rows.find((r) => r.description.toLowerCase().includes("emergancy exit"));
    expect(misc?.partNumber).toBeNull();
  });

  it("captures a matching Build Name across two files that mirror the same design (203 and 211 both 'A.6.3.0')", async () => {
    const { opportunity: opp1, document: doc211 } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");
    const { document: doc203 } = await makeDocumentFrom(SECTION_203_PATH, "Section 203.xlsx");

    const preview211 = await previewDesignCostEstimateImport(doc211.id, opp1.id);
    // Note: doc203 belongs to a DIFFERENT opportunity here (each
    // makeDocumentFrom call creates its own) -- this test only checks the
    // raw parsed buildName values match textually, not the cross-document
    // opportunity-scoped lookup itself (that lives in page.tsx and is
    // exercised live, see the plan's own verification section).
    const opp203 = await db.opportunity.findUniqueOrThrow({ where: { id: doc203.opportunityId } });
    const preview203 = await previewDesignCostEstimateImport(doc203.id, opp203.id);

    expect(preview211.buildName).toBe(preview203.buildName);
  });

  it("captures identical Build Names for a confirmed byte-identical mirror pair (429 and 430, both 'A6.8.0 SECTION 329')", async () => {
    const { opportunity, document: doc429 } = await makeDocumentFrom(SECTION_429_PATH, "Section 429.xlsx");
    const doc430 = (await makeDocumentFrom(SECTION_430_PATH, "Section 430.xlsx")).document;

    const preview429 = await previewDesignCostEstimateImport(doc429.id, opportunity.id);
    const opp430 = await db.opportunity.findUniqueOrThrow({ where: { id: doc430.opportunityId } });
    const preview430 = await previewDesignCostEstimateImport(doc430.id, opp430.id);

    expect(preview429.buildName).toBe("A6.8.0 SECTION 329");
    expect(preview430.buildName).toBe("A6.8.0 SECTION 329");
    const total429 = preview429.rows.reduce((sum, r) => sum + r.qty * r.unitCost, 0);
    const total430 = preview430.rows.reduce((sum, r) => sum + r.qty * r.unitCost, 0);
    expect(total429).toBeCloseTo(total430, 2);
  });
});

describe("commitDesignCostEstimateImport", () => {
  it("commits Section 211 as isDraft LineItems, stamps documentId/buildName, and is idempotent against a second commit", async () => {
    const { opportunity, document } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitDesignCostEstimateImport(version.id, document.id);
    expect(result.rowsImported).toBeGreaterThan(0);
    expect(result.sectionsCreated).toBeGreaterThan(0);

    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    expect(lineItems.length).toBe(result.rowsImported);
    expect(lineItems.every((li) => li.isDraft)).toBe(true);

    const updatedDoc = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.buildName).toBe("A.6.3.0");

    await expect(commitDesignCostEstimateImport(version.id, document.id)).rejects.toThrow(/already been imported/);
  });

  it("stamps a real hardware Part Number onto the committed LineItem's positionCode", async () => {
    const { opportunity, document } = await makeDocumentFrom(CURRENT_SECTION_203_PATH, "Section 203 current.xlsx");
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitDesignCostEstimateImport(version.id, document.id);

    const frame = await db.lineItem.findFirstOrThrow({ where: { documentId: document.id, description: "1/3M X 1/2M FRAME" } });
    expect(frame.positionCode).toBe("606 0310 0434");
  });

  // Confirmed live on a real production estimate: every one of these
  // part descriptions ("310mm x 2418mm Frame", "SEG w/ Blackout White -
  // 168 15/16\" x 95 1/16\"") never contains a category-identifying word,
  // so before mapDesignCostCategoryToCanonical existed, the generic
  // description-only heuristic resolved essentially every row to null --
  // "Other" -- flooding the Review tab with ~527 false "won't bucket
  // correctly" flags on a single estimate. Confirms every row actually
  // committed carries a real (non-"Other") category, using the same
  // catalog+description fallback chain as every other import path, now
  // with the workbook's own banner label given first priority.
  it("commits every row with a resolved category, not just the ones with a catalog match", async () => {
    const { opportunity, document } = await makeDocumentFrom(SECTION_211_PATH, "Section 211.xlsx");
    await db.category.createMany({
      data: [
        { name: "Structure", key: "structure" },
        { name: "Accessories", key: "accessories" },
        { name: "Graphics", key: "graphics" },
        { name: "Labor", key: "labor" },
        { name: "Shipping", key: "shipping" },
        { name: "Flooring", key: "flooring" },
        { name: "Custom Build", key: "custom_build" },
        { name: "Other", key: "other" },
      ],
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitDesignCostEstimateImport(version.id, document.id);

    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    const byDescription = (text: string) => lineItems.find((li) => li.description.includes(text));

    expect(byDescription("2418mm Frame")?.category).toBe("Structure");
    expect(byDescription("Toolless Connector")?.category).toBe("Accessories");
    // SEG fabric is always Graphics regardless of which banner group
    // (here, "Wall Panels") it happens to sit under -- see
    // isAlwaysGraphicsDescription's own comment for why this overrides
    // the banner mapping for this one, unambiguous case.
    expect(byDescription("SEG w/ Blackout White")?.category).toBe("Graphics");
    expect(byDescription("EMERGANCY EXIT")?.category).toBe("Graphics");
    expect(byDescription("Warehouse")?.category).toBe("Labor");
    expect(lineItems.filter((li) => li.category === "Other").length).toBeLessThan(lineItems.length * 0.05);
  });
});

describe("readDesignCostRowsForReconciliation", () => {
  it("reads real Part Numbers and Sq. Ft. values, distinct from category-label placeholders in the same column", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load((await readFile(CURRENT_SECTION_203_PATH)) as unknown as ArrayBuffer);

    const rows = await readDesignCostRowsForReconciliation(workbook);
    expect(rows.length).toBeGreaterThan(0);

    // A real BeMatrix hardware row -- confirmed live to match this same
    // fixture's CAD Pull Sheet counterpart exactly (cad-pull-sheet-
    // service.test.ts's BM1).
    const frame = rows.find((r) => r.description === "1/3M X 1/2M FRAME");
    expect(frame?.partNumber).toBe("606 0310 0434");
    expect(frame?.qty).toBe(1);
    expect(frame?.sqFt).toBeNull();

    // A real Wall Panel row -- confirmed live to match the same CAD Pull
    // Sheet's Area (SqFt) exactly (cad-pull-sheet-service.test.ts's P1).
    const panel = rows.find((r) => r.sqFt === 7.72);
    expect(panel?.type.toLowerCase()).toBe("wall panel");
    expect(panel?.partNumber).toBeNull();

    // "Graphic Panels" section rows reuse the Type/Part Number column for
    // a plain category label ("AV", "LIGHTING", ...), never a real SKU --
    // must not be misread as one just because the column holds text.
    const misc = rows.find((r) => r.type === "LIGHTING");
    expect(misc?.partNumber).toBeNull();
  });
});
