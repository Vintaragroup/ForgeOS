import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractPullSheetRows } from "@/lib/cad-pull-sheet-service";

// Real fixture: one of the 13 CAD PDFs in data/RFP/superbowl/RFP006 -
// Temporary Booth Build/Vendor-pricing-engineering/CAD-files/, confirmed
// live to have its Part Numbers and Sq. Ft. values match the matching
// Excel quote (quotes/SUPER BOWL A 6.3.0 SECTION 203.xlsx, see
// design-cost-estimate-import-service.test.ts's readDesignCostRowsForReconciliation
// tests) exactly.
const SECTION_203_CAD_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/CAD-files/SUPER BOWL A 6.3.0 SECTION 203.pdf",
);

describe("extractPullSheetRows", () => {
  it("finds the Pull Sheet page and reads real BeMatrix Part Numbers and Wall Panel Sq. Ft. values", async () => {
    const bytes = await readFile(SECTION_203_CAD_PATH);

    const result = await extractPullSheetRows(bytes);

    expect(result.status).toBe("COMPLETE");
    if (result.status !== "COMPLETE") return;
    expect(result.pageNumber).toBe(4);
    expect(result.rows.length).toBeGreaterThan(0);

    const bm1 = result.rows.find((r) => r.id === "BM1");
    expect(bm1).toMatchObject({
      qty: 1,
      type: "MIS BeMatrix Frames",
      partNumber: "606 0310 0434",
      description: "1/3M X 1/2M FRAME",
      areaSqFt: null,
    });

    const p1 = result.rows.find((r) => r.id === "P1");
    expect(p1).toMatchObject({
      qty: 1,
      type: "Wall Panel",
      areaSqFt: 7.72,
      partNumber: null,
    });
  });

  it("skips spacer/separator rows and never mis-reads a category-label placeholder as a real Part Number", async () => {
    const bytes = await readFile(SECTION_203_CAD_PATH);

    const result = await extractPullSheetRows(bytes);

    expect(result.status).toBe("COMPLETE");
    if (result.status !== "COMPLETE") return;
    expect(result.rows.some((r) => r.id.toUpperCase() === "SGBLANK")).toBe(false);

    // Real "Miscellaneous"-type rows carry a descriptive label ("Plexi
    // track 3") in the Part Number column position, not a real SKU --
    // confirmed live against this exact file.
    const misc = result.rows.find((r) => r.type === "Miscellaneous");
    expect(misc?.partNumber).toBeNull();
  });
});
