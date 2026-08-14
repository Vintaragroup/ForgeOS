import { describe, expect, it } from "vitest";
import { generateCutSheetDxf } from "@/lib/cut-sheet-dxf";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";

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
    {
      sheetNumber: 2,
      parts: [{ cutListPartId: "c", x: 0, y: 0, width: 10, height: 10, rotated: false, description: "Extra piece" }],
    },
  ],
};

describe("generateCutSheetDxf", () => {
  it("produces well-formed DXF content with the real SECTION structure", () => {
    const content = generateCutSheetDxf(baseData, 1);
    expect(content).toMatch(/^0\r?\nSECTION/);
    expect(content).toContain("ENDSEC");
    expect(content).toContain("EOF");
  });

  it("draws one rectangle for the stock boundary plus one per part, and a text label per part", () => {
    const content = generateCutSheetDxf(baseData, 1);
    // Rectangles are written as closed LWPOLYLINE entities -- one for
    // the stock boundary, one per part (2 parts on sheet 1) = 3 total.
    const polylineCount = (content.match(/LWPOLYLINE/g) ?? []).length;
    expect(polylineCount).toBe(3);
    const textCount = (content.match(/\nTEXT\n/g) ?? []).length;
    expect(textCount).toBe(2);
  });

  it("only includes the requested sheet's parts, not other sheets'", () => {
    const content = generateCutSheetDxf(baseData, 2);
    const polylineCount = (content.match(/LWPOLYLINE/g) ?? []).length;
    // Stock boundary + the 1 part on sheet 2 only.
    expect(polylineCount).toBe(2);
  });

  it("throws a clear error for a sheet number that doesn't exist", () => {
    expect(() => generateCutSheetDxf(baseData, 99)).toThrow(/Sheet 99 not found/);
  });
});
