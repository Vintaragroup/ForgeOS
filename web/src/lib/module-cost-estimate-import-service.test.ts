import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { createEstimateVersion } from "@/lib/estimate-service";
import {
  commitModuleCostEstimateImport,
  detectModuleCostEstimateSheet,
  findModuleCostEstimateSheets,
  parseModuleSheetForTest,
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

  // Replaces this suite's old "refuses a second commit" guard test -- see
  // pricing-import-service.test.ts's identical replacement for the full
  // rationale: fresh Tier 1 exact-match detection now silently excludes
  // an exact duplicate instead of blocking the whole re-commit.
  //
  // Doesn't assert an exact post-exclusion count: a real module-cost
  // workbook can legitimately repeat the exact same description across
  // genuinely distinct rows (this suite's own sibling test already notes
  // three otherwise-identical "PURCHASE SQ FT (basic)" rows that stay
  // distinguishable only because description combines two real cells --
  // when it still collides, findExactDuplicates's "exactly one
  // candidate" ambiguity rule correctly refuses to auto-match rather
  // than guess). What must hold regardless: strictly fewer rows land the
  // second time, and nothing is ever lost or over-counted.
  it("silently excludes every unambiguous row on a second commit of the same document, instead of throwing or re-inserting them", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");
    await db.category.createMany({ data: [{ name: "Labor", key: "labor" }, { name: "Custom Build", key: "custom_build" }] });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const first = await commitModuleCostEstimateImport(version.id, document.id);
    expect(first.rowsImported).toBeGreaterThan(0);

    const second = await commitModuleCostEstimateImport(version.id, document.id);
    expect(second.rowsImported).toBeLessThan(first.rowsImported);

    const lineItems = await db.lineItem.findMany({ where: { documentId: document.id } });
    expect(lineItems.length).toBe(first.rowsImported + second.rowsImported);
  });

  it("re-adds a specific row a reviewer previously deleted, when re-committing the same document after a partial cleanup", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");
    await db.category.createMany({ data: [{ name: "Labor", key: "labor" }, { name: "Custom Build", key: "custom_build" }] });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    const first = await commitModuleCostEstimateImport(version.id, document.id);
    const before = await db.lineItem.findMany({ where: { section: { estimateVersionId: version.id } } });
    expect(before).toHaveLength(first.rowsImported);

    // Pick a row whose description is unique among the committed set --
    // Tier 1 only auto-recognizes an unambiguous description.
    const byDescription = new Map<string, (typeof before)[number][]>();
    for (const li of before) {
      byDescription.set(li.description, [...(byDescription.get(li.description) ?? []), li]);
    }
    const uniqueRows = [...byDescription.values()].filter((group) => group.length === 1).map((group) => group[0]);
    expect(uniqueRows.length).toBeGreaterThan(0); // sanity: the fixture has at least one unambiguous row
    const deleted = uniqueRows[0];
    await db.lineItem.delete({ where: { id: deleted.id } });

    const second = await commitModuleCostEstimateImport(version.id, document.id);
    expect(second.rowsImported).toBeGreaterThan(0);

    const after = await db.lineItem.findMany({ where: { section: { estimateVersionId: version.id } } });
    expect(after.length).toBe(first.rowsImported - 1 + second.rowsImported);
    // The deleted row's own description is present again -- genuine
    // recovery, not a coincidental count match.
    expect(after.filter((li) => li.description === deleted.description)).toHaveLength(1);
  });

  // The real production case this groupKey pass exists for: "Aluminum
  // sheet" appears in this exact real Chicago file under BOTH "FS -
  // Hitting Bay Wall" and "SS - Lounge Structure" -- description alone
  // can never tell those two rows apart, but each one's own module sheet
  // (which becomes its section's groupLabel on commit) can. Deleting
  // just ONE of the two and re-committing must bring back only that one,
  // not both and not neither.
  it("recovers a single deleted row even when its description is shared by another row in a DIFFERENT module sheet, using the sheet name to disambiguate", async () => {
    const { opportunity, document } = await makeDocumentFrom(CHICAGO_PATH, "Chicago ABCA.xlsx");
    await db.category.createMany({
      data: [
        { name: "Structure", key: "structure" },
        { name: "Custom Build", key: "custom_build" },
      ],
    });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);

    await commitModuleCostEstimateImport(version.id, document.id);
    const aluminumRows = await db.lineItem.findMany({
      where: { section: { estimateVersionId: version.id }, description: "Aluminum sheet" },
      include: { section: { select: { groupLabel: true } } },
    });
    // Sanity: this real fixture really does have this row under two
    // distinct sheets -- if this ever stops being true (fixture edited),
    // this test needs a different real row, not a synthetic one.
    expect(aluminumRows).toHaveLength(2);
    expect(new Set(aluminumRows.map((r) => r.section.groupLabel)).size).toBe(2);

    const [toDelete, toKeep] = aluminumRows;
    await db.lineItem.delete({ where: { id: toDelete.id } });

    // Not asserting an exact rowsImported count here -- this large real
    // fixture has its own OTHER ambiguous repeats unrelated to this test
    // (53 descriptions repeat across 2+ sheets in this one file; see the
    // sibling "silently excludes" test's own comment on why some rows
    // stay genuinely unresolvable), so a full re-commit legitimately
    // brings back more than just this one deliberately-deleted row.
    // What this test isolates instead: THIS specific row, by its own
    // description AND sheet, is recovered correctly -- the surviving
    // original sibling is left completely untouched (same id, not
    // re-created), proving groupKey correctly told the two apart rather
    // than guessing.
    await commitModuleCostEstimateImport(version.id, document.id);

    const after = await db.lineItem.findMany({
      where: { section: { estimateVersionId: version.id }, description: "Aluminum sheet" },
    });
    expect(after).toHaveLength(2);
    expect(after.some((li) => li.id === toKeep.id)).toBe(true);
    expect(after.some((li) => li.id === toDelete.id)).toBe(false); // recreated with a new id, not literally restored
  });
});

// A third real dialect of the same shape, from Club Glove's PGA 2027
// estimate. Same module-per-sheet structure, different banner vocabulary
// and different column wording -- built here from the real file's own
// rows, read off production before any assertion was written.
//
// The old detector demanded the literal words "Sheet Goods", "Other
// Items" and "Labor", all three, in that order. This file writes "SHOP
// SUPPLIES" where the others write "Other Items", and some of its modules
// carry no labor at all. That single word rejected the whole 10-sheet
// workbook, so $46,076 of priced, itemized work went through the AI scope
// fallback and came back as 7 guesses at qty 1 with no costs.
function clubGloveSheet(wb: ExcelJS.Workbook, name = "01 Order Writing Counter") {
  const ws = wb.addWorksheet(name);
  ws.addRow(["CLUB GLOVE & LINKS & KINGS @ PGA SHOW 2027", "ORDER-WRITING COUNTER"]);
  ws.addRow([]);
  ws.addRow(["SHEET GOODS"]);
  ws.addRow(["ITEM", "TYPE", "THICKNESS", "SHEET SIZE", "UNIT", "QTY", "COST / ITEM", "EXT COST"]);
  ws.addRow(["PLYWOOD RAW", "Plywood", "3/4 in.", "48 × 96", "Sheets", 6, 60.16, 360.96]);
  ws.addRow(["LAMINATE Blk/Wht", "Laminate", "1/32 in.", "49 × 96", "Sheets", 5, 36.62, 183.1]);
  ws.addRow(["SHEET GOODS TOTAL", 544.06]);
  ws.addRow([]);
  // The banner that used to sink the whole workbook.
  ws.addRow(["SHOP SUPPLIES"]);
  ws.addRow(["ITEM", "UNIT", "QTY", "COST / ITEM", "EXT COST"]);
  ws.addRow(["BUILDING SUPPLIES", "Allowance $", 75, 1, 75]);
  ws.addRow(["SHOP SUPPLIES TOTAL", 75]);
  ws.addRow([]);
  ws.addRow(["LABOR"]);
  ws.addRow(["TYPE", "DESCRIPTION", "UNITS", "HOURS", "RATE / HOUR", "EXT COST"]);
  ws.addRow(["Shop", "PRE/POST PRODUCTION", "Hours", 8, 37.95, 303.6]);
  ws.addRow(["Shop", "FABRICATION / ASSEMBLY", "Hours", 16, 37.95, 607.2]);
  ws.addRow(["LABOR TOTAL", 1499.025]);
  ws.addRow([]);
  ws.addRow(["CATEGORY TOTALS"]);
  ws.addRow(["CATEGORY", "TOTAL"]);
  ws.addRow(["Sheet Goods", 544.06]);
  ws.addRow(["MODULE TOTAL", 2118.09]);
  return ws;
}

describe("the Club Glove dialect", () => {
  it("recognizes a module whose materials block is not called Other Items", () => {
    const wb = new ExcelJS.Workbook();
    expect(detectModuleCostEstimateSheet(clubGloveSheet(wb))).toBe(true);
  });

  it("reads every priced row, with the quantities and costs the sheet states", () => {
    const wb = new ExcelJS.Workbook();
    const rows = parseModuleSheetForTest(clubGloveSheet(wb));
    expect(rows.map((r) => [r.description, r.qty, r.unitCost])).toEqual([
      ["PLYWOOD RAW", 6, 60.16],
      ["LAMINATE Blk/Wht", 5, 36.62],
      ["BUILDING SUPPLIES", 75, 1],
      ["Shop — PRE/POST PRODUCTION", 8, 37.95],
      ["Shop — FABRICATION / ASSEMBLY", 16, 37.95],
    ]);
  });

  // "Category Totals" is this dialect's recap; the rows under it are a
  // cost summary, not work. Without the hard stop it becomes a bogus $0
  // "Sheet Goods" line item -- the same bug "Estimate Totals" already had.
  it("stops at the recap instead of importing it as a line item", () => {
    const wb = new ExcelJS.Workbook();
    const rows = parseModuleSheetForTest(clubGloveSheet(wb));
    expect(rows.some((r) => /category|module total/i.test(r.description))).toBe(false);
  });

  // A pure logistics module: one materials block, no labor at all. The
  // old "all three banners" rule rejected it.
  it("recognizes a module that has materials but no labor", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("08 Logistics and Packaging");
    ws.addRow(["CLUB GLOVE", "LOGISTICS / PACKAGING"]);
    ws.addRow([]);
    ws.addRow(["RENTAL BOOTH I&D CONSUMABLES"]);
    ws.addRow(["ITEM", "UNIT", "QTY", "COST / ITEM", "EXT COST"]);
    ws.addRow(["RENTAL BOOTH I&D CONSUMABLES — 30 × 50 BOOTH", "Sq. Ft.", 1500, 1, 1500]);
    ws.addRow(["MODULE TOTAL", 1500]);
    expect(detectModuleCostEstimateSheet(ws)).toBe(true);
  });

  // The rollup sheet lists the same words as column HEADERS in a
  // populated row, which is not a banner. It must stay out.
  it("still does not mistake the Estimate Summary rollup for a module", () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Estimate Summary");
    ws.addRow(["CLUB GLOVE & LINKS & KINGS @ PGA SHOW 2027 — ORLANDO PRODUCTION ESTIMATE"]);
    ws.addRow(["#", "ESTIMATE MODULE", "SHEET GOODS", "OTHER ITEMS", "LABOR", "TOTAL"]);
    ws.addRow([1, "Order-Writing Counter", 544.06, 75, 1499.025, 2118.09]);
    ws.addRow([2, "Drawer Counters — Qty 2", 1384.56, 550, 2770.35, 4704.91]);
    expect(detectModuleCostEstimateSheet(ws)).toBe(false);
  });
});

// The third real file, whole. Every assertion below was measured off it
// before it was written -- the per-module figures are the workbook's own
// stated MODULE TOTAL on each sheet.
const CLUB_GLOVE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/clubglove/Club Glove & Links & Kings @ PGA Show 2027 Orlando Estimate 092226TA.xlsx",
);

describe("the Club Glove workbook, end to end", () => {
  async function parsedBySheet() {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(CLUB_GLOVE_PATH);
    const sheets = findModuleCostEstimateSheets(wb);
    return new Map(
      sheets.map((ws) => [
        ws.name,
        parseModuleSheetForTest(ws).reduce((sum, r) => sum + r.qty * r.unitCost, 0),
      ]),
    );
  }

  // Every module sheet, and not the rollup.
  it("finds all nine module sheets and leaves the Estimate Summary alone", async () => {
    const bySheet = await parsedBySheet();
    expect(bySheet.size).toBe(9);
    expect([...bySheet.keys()].some((n) => /summary/i.test(n))).toBe(false);
  });

  it("reproduces every module's own stated total", async () => {
    const bySheet = await parsedBySheet();
    const stated: [string, number][] = [
      ["01 Order Writing Counter", 2118.09],
      ["02 Drawer Counter", 4704.91],
      ["03 Illuminated Counters", 6909.53],
      ["04 Two-Tier Display", 1941.42],
      ["05 Wood Grain Feature", 9269.66],
      ["06 Monitor Kiosk", 800.8],
      ["07 beMatrix Structure", 20677.15],
      ["08 Logistics and Packaging", 1500],
      ["09 Client-Owned Furniture", 455.4],
    ];
    for (const [sheet, total] of stated) {
      expect(bySheet.get(sheet), sheet).toBeCloseTo(total, 1);
    }
  });

  // The one that matters most. "BEMATRIX RENTAL PRICING" was an
  // unrecognized banner, so its rows were read with the PREVIOUS table's
  // column map: qty from one table, unit cost landing on the next table's
  // EXT COST column. 1228 x 8596 = $10,555,888 on a $20,677 module, and
  // it reached a real preview screen.
  it("does not read a rental row with the previous table's columns", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(CLUB_GLOVE_PATH);
    const sheet = wb.worksheets.find((w) => /beMatrix/i.test(w.name))!;
    const rental = parseModuleSheetForTest(sheet).find((r) => /STANDARD \+ ADDED FRAME RENTAL/i.test(r.description))!;
    expect(rental.qty).toBe(1228);
    expect(rental.unitCost).toBe(7);
    expect(rental.qty * rental.unitCost).toBe(8596);
  });

  // SEG blocks have no banner at all -- their header follows the frame
  // table's total row directly.
  it("reads the bannerless SEG blocks, and not the unpriced frame lists", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(CLUB_GLOVE_PATH);
    const sheet = wb.worksheets.find((w) => /beMatrix/i.test(w.name))!;
    const rows = parseModuleSheetForTest(sheet);
    const seg = rows.filter((r) => /SEG face/i.test(r.description));
    expect(seg.length).toBeGreaterThan(0);
    expect(seg.reduce((n, r) => n + r.qty * r.unitCost, 0)).toBeCloseTo(9619.34, 1);
    // 86 frames are listed with counts and areas but no price -- they are
    // priced collectively by area in the rental block, so importing them
    // would be scope with no money and a second count of the same thing.
    expect(rows.some((r) => /^beMATRIX FRAME/i.test(r.description))).toBe(false);
  });
});
