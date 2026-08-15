import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { buildCutListLabels, CutListLabelsDocument } from "@/lib/cut-list-labels-pdf";
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
      isRemnant: true,
      width: 12,
      length: 20,
      // Locked/cut sheets still need labels -- the shop floor still has
      // to cut and identify these physical pieces.
      parts: [{ cutListPartId: "c", x: 0, y: 0, width: 10, height: 10, rotated: false, description: "Small block" }],
      locked: true,
      cutAt: new Date("2026-08-14"),
    },
  ],
};

describe("buildCutListLabels", () => {
  it("produces one label per placed-part instance across every sheet, including locked/cut ones", () => {
    const labels = buildCutListLabels("Test Show", baseData, new Map());
    expect(labels).toHaveLength(3);
    expect(labels.map((l) => l.description)).toEqual(["Side panel", "Top panel", "Small block"]);
  });

  it("uses as-placed (post-rotation) dimensions, not the originally entered ones", () => {
    const labels = buildCutListLabels("Test Show", baseData, new Map());
    const topPanel = labels.find((l) => l.description === "Top panel")!;
    expect(topPanel.width).toBe(15);
    expect(topPanel.height).toBe(15);
    expect(topPanel.rotated).toBe(true);
  });

  it("numbers partNumber per-sheet, matching the diagram PDF's own 1-based legend numbering", () => {
    const labels = buildCutListLabels("Test Show", baseData, new Map());
    expect(labels.find((l) => l.description === "Side panel")!.partNumber).toBe(1);
    expect(labels.find((l) => l.description === "Top panel")!.partNumber).toBe(2);
    expect(labels.find((l) => l.description === "Small block")!.partNumber).toBe(1); // first part of sheet 2
    expect(labels.find((l) => l.description === "Small block")!.sheetNumber).toBe(2);
  });

  it("looks up grainConstrained by cutListPartId, defaulting to false when absent from the map", () => {
    const grainMap = new Map([["a", true]]);
    const labels = buildCutListLabels("Test Show", baseData, grainMap);
    expect(labels.find((l) => l.description === "Side panel")!.grainConstrained).toBe(true);
    expect(labels.find((l) => l.description === "Top panel")!.grainConstrained).toBe(false);
  });

  it("carries the show name onto every label", () => {
    const labels = buildCutListLabels("Full Swing -- Baseball & Golf Show", baseData, new Map());
    expect(labels.every((l) => l.showName === "Full Swing -- Baseball & Golf Show")).toBe(true);
  });
});

// Same "renders a real PDF in Node" verification standard as
// cut-sheet-pdf.test.ts.
describe("CutListLabelsDocument", () => {
  it("renders a real, non-trivial PDF buffer", async () => {
    const labels = buildCutListLabels("Test Show", baseData, new Map());
    const buffer = await renderToBuffer(CutListLabelsDocument({ labels }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("renders one page for a label count within a single page's capacity, and paginates once it overflows", async () => {
    const singlePageLabels = buildCutListLabels("Test Show", baseData, new Map()); // 3 labels, well under 24/page
    const singleBuffer = await renderToBuffer(CutListLabelsDocument({ labels: singlePageLabels }));
    const singlePageCount = (singleBuffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(singlePageCount).toBe(1);

    const manyParts = Array.from({ length: 30 }, (_, i) => ({
      cutListPartId: `p${i}`,
      x: 0,
      y: 0,
      width: 5,
      height: 5,
      rotated: false,
      description: `Part ${i}`,
    }));
    const overflowData: CutSheetDiagramData = {
      ...baseData,
      sheets: [{ sheetNumber: 1, isRemnant: false, width: 48, length: 96, parts: manyParts, locked: false, cutAt: null }],
    };
    const overflowLabels = buildCutListLabels("Test Show", overflowData, new Map());
    const overflowBuffer = await renderToBuffer(CutListLabelsDocument({ labels: overflowLabels }));
    const overflowPageCount = (overflowBuffer.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(overflowPageCount).toBe(2);
  });
});
