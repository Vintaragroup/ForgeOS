// Cut-list phase 3 (the paused half): DXF export for CNC, one file per
// PHYSICAL SHEET -- not one combined file per material like the PDF
// diagram bundles. A CNC shop loads one sheet onto the machine bed and
// runs one toolpath file against it, so that's the real unit of
// consumption here, unlike the PDF (which is for a human to read/print,
// where bundling every sheet into one document is the more useful
// shape).
//
// Uses @tarikjabiri/dxf -- confirmed real, typed, zero-dependency,
// actively maintained (72 published versions) before adding it, and its
// actual output verified to be well-formed DXF (real SECTION/ENDSEC
// structure, correct $INSUNITS) via a real generated file, same
// empirical-first discipline as maxrects-packer (phase 2) and
// @react-pdf/renderer's SVG primitives (this phase's PDF half).
//
// Coordinates are used exactly as stored in CutSheet.layout (the same
// x/y/width/height the PDF diagram draws from) with no axis flip -- a
// CNC toolpath only needs internally consistent, non-overlapping
// geometry within the sheet's real bounds, not visual parity with the
// printed diagram's up/down orientation.

import { DxfWriter, Units, Colors, point2d, point3d } from "@tarikjabiri/dxf";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";

const STOCK_LAYER = "STOCK";
const PARTS_LAYER = "PARTS";
const LABELS_LAYER = "LABELS";

// Takes already-fetched CutSheetDiagramData (the same shape/fetch the
// PDF diagram uses) rather than querying the DB itself -- a caller
// rendering both the diagram and a DXF for the same material fetches
// once and passes the result to each, and this stays a pure,
// no-DB-dependency function that's cheap to test directly.
export function generateCutSheetDxf(data: CutSheetDiagramData, sheetNumber: number): string {
  const sheet = data.sheets.find((s) => s.sheetNumber === sheetNumber);
  if (!sheet) {
    throw new Error(`Sheet ${sheetNumber} not found for "${data.materialName}" -- it only has ${data.sheets.length} sheet(s).`);
  }

  const dxf = new DxfWriter();
  dxf.setUnits(Units.Inches);
  dxf.addLayer(STOCK_LAYER, Colors.White);
  dxf.addLayer(PARTS_LAYER, Colors.Cyan);
  dxf.addLayer(LABELS_LAYER, Colors.Yellow);

  // The stock sheet's own boundary -- the CNC's reference for where the
  // physical material actually is, same as the PDF diagram's outer rect.
  // Uses the SHEET's own real usable area (a remnant's own smaller
  // dimensions, when this sheet was cut from one), not the material's
  // nominal stockWidth/stockLength -- a CNC file drawn against the wrong
  // assumed sheet size is a real, physical mistake, not cosmetic.
  dxf.addRectangle(point2d(0, 0), point2d(sheet.width, sheet.length), { layerName: STOCK_LAYER });

  // Small, fixed text height rather than scaled-to-sheet like the PDF's
  // labelFontSize -- DXF text height is a real physical dimension (the
  // letters are actually this many inches tall when cut/printed), not a
  // display-scaled font size, so a fixed 0.25" reads consistently
  // regardless of how big or small the sheet itself is.
  const labelHeight = 0.25;

  if (sheet.isRemnant) {
    dxf.addText(point3d(0.1, sheet.length - labelHeight - 0.1), labelHeight, "REMNANT -- not a fresh sheet", {
      layerName: LABELS_LAYER,
    });
  }

  sheet.parts.forEach((part, i) => {
    dxf.addRectangle(point2d(part.x, part.y), point2d(part.x + part.width, part.y + part.height), {
      layerName: PARTS_LAYER,
    });
    dxf.addText(point3d(part.x + 0.1, part.y + 0.1), labelHeight, `${i + 1}`, { layerName: LABELS_LAYER });
  });

  return dxf.stringify();
}
