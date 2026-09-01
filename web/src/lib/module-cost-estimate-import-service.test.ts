import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import {
  commitModuleCostEstimateImport,
  previewModuleCostEstimateImport,
} from "@/lib/module-cost-estimate-import-service";
import { previewPricingImport } from "@/lib/pricing-import-service";

// Two real files from two different real Full Swing jobs, both
// independently confirmed live this session to share the same "per-module
// Sheet Goods / Other Items / Labor" shape even though their exact column
// wording differs ("Cost / Sheet" vs "Unit Cost", "Qty" vs "Quantity") --
// exactly the real-world drift this parser's alias matching exists for.
// Ground truth (row counts, dollar totals) independently verified this
// session with a raw ExcelJS read of both files before writing any
// assertion here, same "verified against real data" bar this file family
// already holds itself to.
const CHICAGO_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/Full_Swing_Chicago/ABCA_2027_Exhibit_Cost_Breakout.xlsx",
);
const ORLANDO_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/Full_Swing/Full Swing @ PGA 2027 Orlando Estimate 082526TA.xlsx",
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
  await db.lineItemAuditLog.deleteMany();
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
  it("recognizes the per-module Sheet Goods/Other Items/Labor shape and delegates to the new parser, not the AI fallback or flat-schedule one", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");

    const preview = await previewPricingImport(document.id, opportunity.id);

    expect(preview.kind).toBe("module-cost-estimate");
  });
});

describe("previewModuleCostEstimateImport", () => {
  it("itemizes every real Sheet Goods/Other Items/Labor row across all 8 real element sheets in the Chicago file, skipping its Summary and Data Notes sheets", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");

    const preview = await previewModuleCostEstimateImport(document.id, opportunity.id);

    expect(preview.rows).toHaveLength(192);
    expect(new Set(preview.rows.map((r) => r.sheetName))).toEqual(
      new Set([
        "FS - Hitting Bay Wall",
        "FS - Sign 3ft10 Qty4",
        "FS - Sign 5ft4",
        "FS - Sign 6ft6",
        "FS - Reception Counter",
        "FS - Lit Spines Lounge",
        "SS - Lit Spines Hit Bay",
        "SS - Lounge Structure",
      ]),
    );

    // Real dollar total from the workbook's own Grand Total cell.
    const total = preview.rows.reduce((sum, r) => sum + r.qty * r.unitCost, 0);
    expect(total).toBeCloseTo(201910.29, 2);

    // A real, individually-priced Sheet Goods row -- this is exactly the
    // granularity the AI-fallback importer was collapsing away.
    const aluminumRow = preview.rows.find((r) => r.description === "Aluminum sheet" && r.sheetName === "FS - Hitting Bay Wall");
    expect(aluminumRow).toBeDefined();
    expect(aluminumRow?.subTable).toBe("sheet-goods");
    expect(aluminumRow?.qty).toBe(1);
    expect(aluminumRow?.unitCost).toBe(180);

    // A real Labor row, combining its Labor Type + Description cells.
    const laborRow = preview.rows.find((r) => r.description.includes("frame fab"));
    expect(laborRow?.description).toBe("30% Shop — frame fab");
    expect(laborRow?.subTable).toBe("labor");
    expect(laborRow?.qty).toBe(18);
    expect(laborRow?.unitCost).toBeCloseTo(37.95, 2);
  });

  it("itemizes all 32 real module sheets in the Orlando file and correctly produces zero rows -- not a bogus 'Estimate Totals' row -- for its two genuinely-empty placeholder modules", async () => {
    const { opportunity, document } = await makeDocumentFrom(ORLANDO_PATH, "Orlando 082526TA.xlsx");

    const preview = await previewModuleCostEstimateImport(document.id, opportunity.id);

    expect(preview.rows).toHaveLength(309);
    expect(preview.rows.some((r) => r.sheetName === "Estimate Summary")).toBe(false);

    // Regression test for the exact bug caught by running this parser
    // against the real file before writing this test: modules 12 and 13
    // ("Lighting / Electrical — Small Sim Left/Right Side") are real,
    // unpriced template copies -- every row across all three sub-tables
    // reads the literal placeholder "—" with qty/cost both 0. Without the
    // "Estimate Totals" stop signal, the parser would misread that
    // module's own trailing cost-recap block as one bogus extra line
    // item ("Estimate Totals — Cost", qty 0, $0).
    const smallSimLeft = preview.rows.filter((r) => r.sheetName === "12 Lighting  Electrical  Smal");
    const smallSimRight = preview.rows.filter((r) => r.sheetName === "13 Lighting  Electrical  Smal");
    expect(smallSimLeft).toHaveLength(0);
    expect(smallSimRight).toHaveLength(0);
    expect(preview.rows.some((r) => r.description.includes("Estimate Totals"))).toBe(false);

    // Real dollar total from the workbook's own Project Total cell.
    const total = preview.rows.reduce((sum, r) => sum + r.qty * r.unitCost, 0);
    expect(total).toBeCloseTo(223376.5875, 2);
  });
});

describe("commitModuleCostEstimateImport", () => {
  it("commits real per-module sections (groupLabel = sheet name), isDraft LineItems, and the right category split", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");
    await db.category.createMany({
      data: [
        { name: "Structure", key: "structure" },
        { name: "Labor", key: "labor" },
        { name: "Custom Build", key: "custom_build" },
        { name: "Graphics", key: "graphics" },
        { name: "Accessories", key: "accessories" },
        { name: "Shipping", key: "shipping" },
      ],
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const result = await commitModuleCostEstimateImport(version.id, document.id);

    expect(result.rowsImported).toBe(192);
    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    expect(lineItems).toHaveLength(192);
    expect(lineItems.every((li) => li.isDraft)).toBe(true);

    const sections = await db.estimateSection.findMany({ where: { estimateVersionId: version.id } });
    // Real per-module sections -- one groupLabel per element sheet, not
    // one flat bucket the way the AI-fallback importer used to commit.
    expect(new Set(sections.map((s) => s.groupLabel))).toEqual(
      new Set([
        "FS - Hitting Bay Wall",
        "FS - Sign 3ft10 Qty4",
        "FS - Sign 5ft4",
        "FS - Sign 6ft6",
        "FS - Reception Counter",
        "FS - Lit Spines Lounge",
        "SS - Lit Spines Hit Bay",
        "SS - Lounge Structure",
      ]),
    );

    // Sheet Goods rows -> always Custom Build (raw fabrication input).
    const aluminumItem = lineItems.find((li) => li.description === "Aluminum sheet");
    expect(aluminumItem?.category).toBe("Custom Build");

    // Labor rows -> always Labor.
    const laborItem = lineItems.find((li) => li.description.includes("frame fab"));
    expect(laborItem?.category).toBe("Labor");
    expect(laborItem?.lineType).toBe("LABOR");

    // Other Items rows -> resolved via the row's own Category cell --
    // "beMatrix" maps to Structure. Description combines the Item +
    // Description columns (two separate real cells -- see this file's
    // own header comment) so three otherwise-identical "PURCHASE SQ FT
    // (basic)" rows stay distinguishable.
    const bematrixItem = lineItems.find((li) => li.description === "PURCHASE SQ FT (basic) — ceiling");
    expect(bematrixItem?.category).toBe("Structure");
  });

  it("refuses a second commit of the same document into the same version", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");
    await db.category.createMany({ data: [{ name: "Labor", key: "labor" }, { name: "Custom Build", key: "custom_build" }] });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitModuleCostEstimateImport(version.id, document.id);

    await expect(commitModuleCostEstimateImport(version.id, document.id)).rejects.toThrow(/already been imported/);
  });
});
