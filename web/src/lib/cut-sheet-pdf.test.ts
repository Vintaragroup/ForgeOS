import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { CutSheetDiagramDocument } from "@/lib/cut-sheet-pdf";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";

// @react-pdf/renderer is pure JS (no headless browser), so this actually
// renders a real PDF in Node -- not much else in this app has that
// property to unit-test against. Checking real PDF output (the %PDF
// magic bytes, a non-trivial size, one page per sheet) is a meaningfully
// stronger check than "the component didn't throw" alone, without
// needing to inspect pixel output.
describe("CutSheetDiagramDocument", () => {
  const baseData: CutSheetDiagramData = {
    materialName: "3/4in Plywood",
    stockWidth: 48,
    stockLength: 96,
    sheets: [
      {
        sheetNumber: 1,
        parts: [
          { cutListPartId: "a", x: 0, y: 0, width: 20, height: 20, rotated: false, description: "Side panel" },
          { cutListPartId: "b", x: 20, y: 0, width: 15, height: 15, rotated: true, description: "Top panel" },
        ],
      },
    ],
  };

  it("renders a real, non-trivial PDF buffer for a single sheet", async () => {
    const buffer = await renderToBuffer(CutSheetDiagramDocument({ data: baseData }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("renders one page per sheet for a multi-sheet material", async () => {
    const twoSheets: CutSheetDiagramData = {
      ...baseData,
      sheets: [
        baseData.sheets[0],
        { sheetNumber: 2, parts: [{ cutListPartId: "c", x: 0, y: 0, width: 10, height: 10, rotated: false, description: "Extra piece" }] },
      ],
    };
    const buffer = await renderToBuffer(CutSheetDiagramDocument({ data: twoSheets }));
    // /Type/Page (not /Pages, the tree root) appears once per actual
    // page in a real PDF's object structure -- a simple, real way to
    // confirm page count without a full PDF parser dependency.
    const pageCount = (buffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(pageCount).toBe(2);
  });

  it("renders without throwing for a part too small to fit an inline dimension label", async () => {
    const tinyPart: CutSheetDiagramData = {
      ...baseData,
      sheets: [{ sheetNumber: 1, parts: [{ cutListPartId: "tiny", x: 0, y: 0, width: 0.5, height: 0.5, rotated: false, description: "Tiny spacer block" }] }],
    };
    const buffer = await renderToBuffer(CutSheetDiagramDocument({ data: tinyPart }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders without throwing for a very small sheet (no divide-by-zero on scale/font sizing)", async () => {
    const smallSheet: CutSheetDiagramData = {
      materialName: "Scrap MDF",
      stockWidth: 4,
      stockLength: 4,
      sheets: [{ sheetNumber: 1, parts: [{ cutListPartId: "a", x: 0, y: 0, width: 2, height: 2, rotated: false, description: "Corner block" }] }],
    };
    const buffer = await renderToBuffer(CutSheetDiagramDocument({ data: smallSheet }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });
});
