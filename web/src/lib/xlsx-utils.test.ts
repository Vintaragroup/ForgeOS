import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { serializeWorkbookForPrompt } from "@/lib/xlsx-utils";

// Real fixtures from the "Full Swing PGA Orlando" job -- confirmed live
// (this session's own investigation) to be two more distinct spreadsheet
// shapes neither of this app's deterministic importers recognizes. Used
// here specifically because the Fuse bid's own Executive Summary sheet
// has both a genuine merged-title-row artifact AND several real,
// unmerged cells that happen to share the same value ($400, $924) --
// exactly the case that broke an earlier text-equality-based dedupe
// attempt during development (silently dropped two of three real $400s).
const FUSE_BID_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/Full_Swing/EXPO_CCI_Full_Swing_PGA_Orlando_Bid_Breakdown.xlsx",
);
const FABRICATION_ESTIMATE_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/Full_Swing/Full Swing @ PGA 2027 Orlando Estimate 082526TA.xlsx",
);

async function loadWorkbook(filePath: string) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await readFile(filePath)) as unknown as ArrayBuffer);
  return wb;
}

describe("serializeWorkbookForPrompt", () => {
  it("collapses a genuinely merged title row to one instance, not one per spanned column", async () => {
    const wb = await loadWorkbook(FUSE_BID_PATH);
    const text = serializeWorkbookForPrompt(wb);

    const titleOccurrences = text.split("EXPO CCI — Full Swing PGA Expo, Orlando — Bid Summary").length - 1;
    expect(titleOccurrences).toBe(1);
  });

  it("preserves three genuinely distinct, unmerged cells that happen to share the same value -- never collapsed as if they were a merge artifact", async () => {
    const wb = await loadWorkbook(FUSE_BID_PATH);
    const text = serializeWorkbookForPrompt(wb);

    // Real row 6 ("Sales Sub-Total"): Video V1, Video V2, and Lighting
    // each really do cost $400 independently (Rigging is $200) -- four
    // distinct unmerged cells, not a merge spanning them.
    const salesRow = text.split("\n").find((line) => line.startsWith("Row 6:"));
    expect(salesRow).toBeDefined();
    expect(salesRow).toBe("Row 6: Sales Sub-Total | 400 | 400 | 400 | 200");
  });

  it("includes every real sheet name from a real multi-sheet workbook", async () => {
    const wb = await loadWorkbook(FUSE_BID_PATH);
    const text = serializeWorkbookForPrompt(wb);

    for (const name of ["Executive Summary", "Video V1", "Video V2", "Lighting (LX)", "Rigging"]) {
      expect(text).toContain(`## Sheet: ${name}`);
    }
  });

  it("caps rows per sheet and notes how many were omitted, on the real 33-sheet fabrication estimate", async () => {
    const wb = await loadWorkbook(FABRICATION_ESTIMATE_PATH);
    const text = serializeWorkbookForPrompt(wb, { maxRowsPerSheet: 5 });
    const sections = text.split(/^## Sheet: /m);
    const summarySection = sections.find((s) => s.startsWith("Estimate Summary"))!;

    expect(summarySection).toMatch(/more row\(s\) omitted from "Estimate Summary"/);
    // A capped sheet never emits a row past the cap.
    expect(summarySection).not.toMatch(/Row 6:/);
  });

  it("reads real per-item pricing rows from the fabrication estimate's own 'Sheet Goods' sub-table", async () => {
    const wb = await loadWorkbook(FABRICATION_ESTIMATE_PATH);
    const text = serializeWorkbookForPrompt(wb);

    expect(text).toContain("Birch Ply PF1S");
    expect(text).toContain("1650"); // that row's real Ext Cost
  });
});
