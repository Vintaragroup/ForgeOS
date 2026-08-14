import { describe, expect, it } from "vitest";
import { computeAlignedPosition } from "@/components/cut-sheet-diagram-editor";
import type { PlacedPart } from "@/lib/cut-sheet-geometry";

// A 6px-equivalent threshold in a sheet-inch coordinate space -- matches
// how the real component derives thresholdIn (SNAP_PIXELS / scale), just
// picked directly here since these tests exercise the pure function, not
// the pixel/scale conversion around it.
const THRESHOLD = 0.5;
// Matches CutListSettings.dragGridSnap's own schema default -- these
// tests exercise the fallback-to-grid behavior against that same value.
const GRID_SNAP = 0.25;

describe("computeAlignedPosition", () => {
  it("falls back to the plain grid snap when nothing is within threshold", () => {
    const { x, y, guides } = computeAlignedPosition(10.1, 10.1, 5, 5, [], 48, 96, THRESHOLD, GRID_SNAP);
    expect(x).toBe(10); // nearest 0.25
    expect(y).toBe(10);
    expect(guides).toEqual([]);
  });

  it("snaps a part's left edge to another part's right edge, within threshold", () => {
    const other: PlacedPart[] = [{ cutListPartId: "a", x: 0, y: 0, width: 10, height: 10, rotated: false }];
    // Candidate left edge (20.3) is close to other's right edge (10)? No --
    // pick a candidate whose left edge (10.3) is close to other's right edge (10).
    const { x, guides } = computeAlignedPosition(10.3, 30, 5, 5, other, 48, 96, THRESHOLD, GRID_SNAP);
    expect(x).toBe(10);
    expect(guides).toContainEqual({ axis: "x", position: 10 });
  });

  it("snaps a part's center to another part's center", () => {
    // other spans x=[10,20], center=15. Dragged part width=4, candidate
    // left=12.7 -> its own center=14.7, within 0.5 of 15.
    const other: PlacedPart[] = [{ cutListPartId: "a", x: 10, y: 0, width: 10, height: 10, rotated: false }];
    const { x, guides } = computeAlignedPosition(12.7, 30, 4, 4, other, 48, 96, THRESHOLD, GRID_SNAP);
    expect(x).toBe(13); // left = center(15) - width/2(2)
    expect(guides).toContainEqual({ axis: "x", position: 15 });
  });

  it("snaps to the sheet's own edges and center, not just other parts", () => {
    const { x, guides } = computeAlignedPosition(0.2, 30, 5, 5, [], 48, 96, THRESHOLD, GRID_SNAP);
    expect(x).toBe(0);
    expect(guides).toContainEqual({ axis: "x", position: 0 });
  });

  it("produces guides on both axes when a corner aligns with another part's corner", () => {
    // other spans x=[10,20] y=[10,20] -- its bottom-right corner is (20,20).
    // Dragged part (width=5,height=5) candidate near (20.2, 20.2) so its
    // own top-left corner (its start) lands near that corner.
    const other: PlacedPart[] = [{ cutListPartId: "a", x: 10, y: 10, width: 10, height: 10, rotated: false }];
    const { x, y, guides } = computeAlignedPosition(20.2, 20.2, 5, 5, other, 48, 96, THRESHOLD, GRID_SNAP);
    expect(x).toBe(20);
    expect(y).toBe(20);
    expect(guides).toHaveLength(2);
    expect(guides).toContainEqual({ axis: "x", position: 20 });
    expect(guides).toContainEqual({ axis: "y", position: 20 });
  });

  it("prefers the closest match when multiple reference lines are within threshold", () => {
    // Sheet center (24) and an other part's edge (24.3) are both within
    // threshold of a candidate at 24.1 -- the closer one (24.1 itself, if
    // exactly a ref) should win. Here candidate left=24.05, closest ref is
    // the sheet center at 24 (delta 0.05) vs the part edge at 24.3 (delta 0.25).
    const other: PlacedPart[] = [{ cutListPartId: "a", x: 19.3, y: 0, width: 5, height: 5, rotated: false }]; // right edge = 24.3
    const { x, guides } = computeAlignedPosition(24.05, 30, 5, 5, other, 48, 96, THRESHOLD, GRID_SNAP);
    expect(x).toBe(24);
    expect(guides).toContainEqual({ axis: "x", position: 24 });
  });
});
