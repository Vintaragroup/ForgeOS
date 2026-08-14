import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CutSheetDiagram } from "@/components/cut-sheet-diagram";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";

// A plain server component (no hooks, no DB) -- renderToStaticMarkup
// (ships with react-dom, already a dependency) is enough to check real
// rendered SVG output without needing a new testing-library dependency,
// same "add zero unnecessary dependencies" discipline as the rest of
// this feature.
describe("CutSheetDiagram", () => {
  const sheet: CutSheetDiagramData["sheets"][number] = {
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
  };

  it("renders one <rect> per part plus the stock boundary, at the real placed coordinates", () => {
    const html = renderToStaticMarkup(<CutSheetDiagram estimateId="e1" versionId="v1" materialId="m1" sheet={sheet} sheetCount={1} />);
    const rectCount = (html.match(/<rect/g) ?? []).length;
    expect(rectCount).toBe(1 + sheet.parts.length); // stock boundary + 2 parts
    expect(html).toContain('x="0" y="0" width="20" height="20"');
    expect(html).toContain('x="20" y="0" width="15" height="15"');
  });

  it("draws the sheet's own dimensions as the SVG viewBox, not the material's nominal stock size", () => {
    const remnantSheet: CutSheetDiagramData["sheets"][number] = { ...sheet, isRemnant: true, width: 12, length: 20 };
    const html = renderToStaticMarkup(<CutSheetDiagram estimateId="e1" versionId="v1" materialId="m1" sheet={remnantSheet} sheetCount={1} />);
    expect(html).toContain('viewBox="0 0 12 20"');
    expect(html).toContain("Remnant");
  });

  it("omits the Remnant label for an ordinary fresh sheet", () => {
    const html = renderToStaticMarkup(<CutSheetDiagram estimateId="e1" versionId="v1" materialId="m1" sheet={sheet} sheetCount={1} />);
    expect(html).not.toContain("Remnant");
  });

  it("shows the sheet number and total count in the header", () => {
    const html = renderToStaticMarkup(<CutSheetDiagram estimateId="e1" versionId="v1" materialId="m1" sheet={sheet} sheetCount={3} />);
    expect(html).toContain("Sheet 1 of 3");
  });
});
