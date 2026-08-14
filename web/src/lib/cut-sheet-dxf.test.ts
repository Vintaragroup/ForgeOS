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
      isRemnant: false,
      width: 48,
      length: 96,
      parts: [
        { cutListPartId: "a", x: 0, y: 0, width: 20, height: 20, rotated: false, description: "Side panel" },
        { cutListPartId: "b", x: 20, y: 0, width: 15, height: 15, rotated: true, description: "Top panel" },
      ],
      locked: false,
      cutAt: null,
    },
    {
      sheetNumber: 2,
      isRemnant: false,
      width: 48,
      length: 96,
      parts: [{ cutListPartId: "c", x: 0, y: 0, width: 10, height: 10, rotated: false, description: "Extra piece" }],
      locked: false,
      cutAt: null,
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

  it("draws the stock boundary at the remnant's own (smaller) size and adds a REMNANT text label", () => {
    const remnantData: CutSheetDiagramData = {
      materialName: "3/4in Plywood",
      stockWidth: 48,
      stockLength: 96,
      sheets: [
        {
          sheetNumber: 1,
          isRemnant: true,
          width: 12,
          length: 20,
          parts: [{ cutListPartId: "a", x: 0, y: 0, width: 10, height: 10, rotated: false, description: "Small block" }],
          locked: false,
          cutAt: null,
        },
      ],
    };
    const content = generateCutSheetDxf(remnantData, 1);
    expect(content).toContain("REMNANT -- not a fresh sheet");
    // The stock boundary polyline's vertices should reflect the
    // remnant's own 12x20 size, not the material's nominal 48x96 --
    // matched as whole DXF value tokens (own line) to avoid false
    // positives/negatives from substrings elsewhere in the file.
    expect(content).toMatch(/\n12(\.0+)?\n/);
    expect(content).toMatch(/\n20(\.0+)?\n/);
    expect(content).not.toMatch(/\n48(\.0+)?\n/);
    expect(content).not.toMatch(/\n96(\.0+)?\n/);
  });

  it("omits the REMNANT text label for an ordinary fresh sheet", () => {
    const content = generateCutSheetDxf(baseData, 1);
    expect(content).not.toContain("REMNANT");
  });
});
