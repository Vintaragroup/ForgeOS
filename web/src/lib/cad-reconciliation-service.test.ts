import { readFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { extractPullSheetRows } from "@/lib/cad-pull-sheet-service";
import { readDesignCostRowsForReconciliation } from "@/lib/design-cost-estimate-import-service";
import { reconcileRows, type ReconciliationRow } from "@/lib/cad-reconciliation-service";

// The real, matching CAD/Excel pair for Section 203 -- see
// cad-pull-sheet-service.test.ts and design-cost-estimate-import-
// service.test.ts's readDesignCostRowsForReconciliation tests for the
// individually-confirmed Part Number/Sq. Ft. values this test relies on.
const CAD_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/CAD-files/SUPER BOWL A 6.3.0 SECTION 203.pdf",
);
const EXCEL_PATH = path.resolve(
  import.meta.dirname,
  "../../../data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/quotes/SUPER BOWL A 6.3.0 SECTION 203.xlsx",
);

async function loadRealPair() {
  const pullSheet = await extractPullSheetRows(await readFile(CAD_PATH));
  if (pullSheet.status !== "COMPLETE") throw new Error(pullSheet.reason);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await readFile(EXCEL_PATH)) as unknown as ArrayBuffer);
  const excelRows = await readDesignCostRowsForReconciliation(workbook);
  return { cadRows: pullSheet.rows, excelRows };
}

function byDetail(rows: ReconciliationRow[], substring: string) {
  return rows.find((r) => r.detail.includes(substring));
}

describe("reconcileRows", () => {
  it("matches the real BM1 hardware Part Number and P1 Wall Panel area cleanly", async () => {
    const { cadRows, excelRows } = await loadRealPair();

    const rows = reconcileRows(cadRows, excelRows);

    const bm1Match = byDetail(rows, "606 0310 0434");
    expect(bm1Match?.status).toBe("MATCHED");

    const p1Match = byDetail(rows, "7.72 sqft");
    expect(p1Match?.status).toBe("MATCHED");
  });

  it("groups duplicate same-area CAD/Excel panel entries instead of flagging them ambiguous", async () => {
    const { cadRows, excelRows } = await loadRealPair();

    const rows = reconcileRows(cadRows, excelRows);

    // Real data: panel P7 appears twice on the CAD Pull Sheet (both faces
    // of a return wall) at 39 sqft, and the Excel quote independently has
    // two rows at 39 sqft too -- these must net out as one clean 2-vs-2
    // group comparison, not a pairwise tie between individual rows.
    expect(rows.filter((r) => r.status === "AMBIGUOUS")).toHaveLength(0);
    const p7 = byDetail(rows, "39 sqft");
    expect(p7?.status).toBe("MATCHED");
  });

  it("flags a real qty discrepancy between the CAD Pull Sheet and the Excel quote for the same Part Number", async () => {
    const { cadRows, excelRows } = await loadRealPair();

    const rows = reconcileRows(cadRows, excelRows);

    // Confirmed live: the CAD Pull Sheet has exactly one "614 2418 S04 TG"
    // post (qty 1), but the Excel quote sums to 3 across two rows -- a
    // genuine real-world discrepancy this feature exists to catch, not a
    // parsing artifact.
    const mismatch = byDetail(rows, "614 2418 S04 TG");
    expect(mismatch?.status).toBe("QTY_MISMATCH");
    expect(mismatch?.cad?.qty).toBe(1);
    expect(mismatch?.excel?.qty).toBe(3);
  });

  it("excludes Graphic Panels category-label rows entirely rather than false-matching them", async () => {
    const { cadRows, excelRows } = await loadRealPair();

    // Real "Miscellaneous"/"LIGHTING"/etc. rows have neither a real Part
    // Number nor a comparable area on either side -- they must be left
    // out of the report entirely (not falsely reported as MATCHED,
    // AREA_MISMATCH, or even ONLY_IN_EXCEL against an unrelated item).
    expect(excelRows.some((r) => r.type === "LIGHTING")).toBe(true);

    const rows = reconcileRows(cadRows, excelRows);

    const mentionsMisc = rows.some(
      (r) =>
        r.cad?.description.toLowerCase().includes("emergancy") ||
        r.excel?.description.toLowerCase().includes("emergancy"),
    );
    expect(mentionsMisc).toBe(false);
  });
});
