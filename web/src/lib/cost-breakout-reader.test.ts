import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { readCostBreakout, readCostBreakoutSheet } from "@/lib/cost-breakout-reader";

// Full Swing's real tab shape, down to the banner rows and the subtotals
// between blocks. Built rather than fixtured so the structure under test
// is visible in the test.
function sheet(name = "FS - Sign 3ft10 Qty4"): ExcelJS.Worksheet {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(name);
  const banner = (t: string) => ws.addRow([t, t, t, t, t, t, t]);

  banner('Full Swing - Diamond Sign Logo 3\'10" (Qty 4, Side Walls)');
  ws.addRow([]);
  banner("SHEET GOODS");
  ws.addRow(["Material", "Thickness", "Width", "Length", "Unit Cost", "Units", "Quantity"]);
  ws.addRow(["Acrylic #2447 for int light", '1"', '48"', '96"', 950, "Sheets", 2]);
  ws.addRow(["China Birch", '3/4"', '48"', '96"', 46.5, "Sheets", 2]);
  ws.addRow(["China Birch", '1/4"', '48"', '96"', 23, "Sheets", 2]);
  banner("Sheet Goods Subtotal");
  ws.addRow([]);
  banner("OTHER ITEMS");
  ws.addRow(["Category", "Item", "Description", "Unit Cost", "Units", "Quantity", "Total Cost"]);
  ws.addRow(["Lighting and Electrical", "LED Driver 8.3A 24V", "", 85, "Each", 5, 425]);
  ws.addRow(["Graphics", "SEG BACKLIT", "8.5ft x 21 - 179", 9.78, "Sq. Ft.", 179, 1750.62]);
  banner("Other Items Subtotal");
  ws.addRow([]);
  banner("LABOR");
  ws.addRow(["Labor Type", "Description", "Hourly Rate", "Hours", "Total Cost"]);
  ws.addRow(["30% Shop", "build and lam", 37.95, 20, 759]);
  ws.addRow(["30% CNC op", "", 47.15, 8, 377.2]);
  banner("Labor Subtotal");
  banner("PROJECT TOTAL");
  return ws;
}

describe("readCostBreakoutSheet", () => {
  const parsed = readCostBreakoutSheet(sheet())!;

  it("reads every row of work and no banner, header or subtotal", () => {
    expect(parsed.rows).toHaveLength(7);
    expect(parsed.rows.map((r) => r.description)).toEqual([
      "Acrylic #2447 for int light",
      "China Birch",
      "China Birch",
      "LED Driver 8.3A 24V",
      "SEG BACKLIT — 8.5ft x 21 - 179",
      "30% Shop — build and lam",
      "30% CNC op",
    ]);
  });

  it("keeps the element title, which carries spec changes nothing else records", () => {
    expect(parsed.title).toContain("Diamond Sign Logo 3'10\"");
  });

  // The three blocks do not share a column layout, and indexing one
  // column for all of them is what joined 99 of 192 line items instead
  // of 192.
  describe("each block's own columns", () => {
    const by = (d: string) => parsed.rows.find((r) => r.description === d)!;

    it("reads sheet goods from Material, with the quantity in the last column", () => {
      const row = by("Acrylic #2447 for int light");
      expect(row.block).toBe("SHEET_GOODS");
      expect(row.unitCost).toBe(950);
      expect(row.qty).toBe(2);
      expect(row.unit).toBe("Sheets");
    });

    it("reads other items from Item, folding in the Description cell", () => {
      const row = by("SEG BACKLIT — 8.5ft x 21 - 179");
      expect(row.block).toBe("OTHER_ITEMS");
      expect(row.unitCost).toBe(9.78);
      expect(row.qty).toBe(179);
    });

    // An hour is a quantity and a rate is a unit cost, so labour needs
    // no special case anywhere downstream.
    it("reads labour as rate and hours", () => {
      const row = by("30% Shop — build and lam");
      expect(row.block).toBe("LABOR");
      expect(row.unitCost).toBe(37.95);
      expect(row.qty).toBe(20);
    });

    it("leaves a labour row with no description standing on its type alone", () => {
      expect(by("30% CNC op").qty).toBe(8);
    });
  });

  // "China Birch" is two materials at two thicknesses and two prices.
  it("keeps two rows that share a name apart by their variant", () => {
    const birch = parsed.rows.filter((r) => r.description === "China Birch");
    expect(birch).toHaveLength(2);
    expect(birch.map((r) => r.variant)).toEqual(['3/4"', '1/4"']);
    expect(birch.map((r) => r.unitCost)).toEqual([46.5, 23]);
  });
});

describe("readCostBreakout", () => {
  // A Data Notes tab carrying the word "Category" in column A was read
  // as an element with five rows of work in it, and then reported as a
  // whole element deleted when the revised workbook dropped the tab.
  // Block headers are matched on two cells for that reason.
  it("does not mistake a notes tab for an element", () => {
    const wb = new ExcelJS.Workbook();
    const notes = wb.addWorksheet("Data Notes");
    notes.addRow(["Data Notes"]);
    notes.addRow(["Category", "three files arrived under the wrong client name"]);
    notes.addRow(["Material", "priced from the 9/12 drawing set"]);
    expect(readCostBreakout(wb)).toEqual([]);
  });

  it("skips sheets that are not element tabs", () => {
    const wb = new ExcelJS.Workbook();
    const summary = wb.addWorksheet("Summary");
    summary.addRow(["Client", "Element", "Project Total"]);
    summary.addRow(["Full Swing", "Hitting Bay", 43849.05]);
    const notes = wb.addWorksheet("Data Notes");
    notes.addRow(["three files arrived under the wrong client name"]);

    // Skipped by shape, not by name -- a workbook that renames either
    // still reads correctly.
    expect(readCostBreakout(wb)).toEqual([]);
  });
});
