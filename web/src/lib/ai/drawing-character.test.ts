import { describe, expect, it } from "vitest";
import {
  assessDrawingCharacter,
  characterMismatchGuidance,
  charactersDiffer,
} from "@/lib/ai/drawing-character";

// Verbatim from Full Swing's superseded component sheet -- every one of
// its 14 extracted items carried a dimension.
const COMPONENT_SHEET = [
  `Hanging sign dimensions: 90' x 20' x 8' (8' at thickest point, 4' at thinnest point) double sided stretch fabric.`,
  `Large can letter sets: 24' x 5'9".`,
  `Batting cage dimensions: 55' x 14' x 15'10" tall.`,
  `L shape reception counter dimensions: 8' x 6' x 40".`,
  `Counter thickness: 20".`,
];

// Verbatim from its replacement -- none of its 33 items carried one, and
// eight said the specification was not called out.
const RENDERING_SET = [
  "Chain-link fence/netting material for batting cage enclosure",
  "Black metal structural framing for overhead support and cage",
  "Green artificial turf flooring material",
  "Overhead signage structures displaying 'FULL SWING KIT' text - no dimensions provided",
  "Display screens showing baseball performance metrics - screen specifications not provided",
];

describe("assessDrawingCharacter", () => {
  it("recognises a dimensioned component set", () => {
    const a = assessDrawingCharacter(COMPONENT_SHEET);
    expect(a.character).toBe("DIMENSIONED");
    expect(a.dimensionedCount).toBe(COMPONENT_SHEET.length);
  });

  it("recognises a rendering package", () => {
    const a = assessDrawingCharacter(RENDERING_SET);
    expect(a.character).toBe("RENDERING");
    expect(a.dimensionedCount).toBe(0);
    expect(a.unspecifiedCount).toBeGreaterThan(0);
  });

  // Admitting uncertainty beats forcing a bucket.
  it("calls a genuine mix MIXED rather than guessing", () => {
    const a = assessDrawingCharacter([...COMPONENT_SHEET.slice(0, 2), ...RENDERING_SET.slice(0, 3)]);
    expect(a.character).toBe("MIXED");
  });

  it("is UNKNOWN for a drawing nothing was extracted from", () => {
    expect(assessDrawingCharacter([]).character).toBe("UNKNOWN");
  });
});

describe("charactersDiffer", () => {
  // The actual Full Swing pair, and the reason the first real comparison
  // reported a batting cage present in both sets as ADDED.
  it("flags a component set against a rendering set", () => {
    expect(charactersDiffer("DIMENSIONED", "RENDERING")).toBe(true);
    expect(charactersDiffer("RENDERING", "DIMENSIONED")).toBe(true);
  });

  it("does not flag two of a kind", () => {
    expect(charactersDiffer("RENDERING", "RENDERING")).toBe(false);
    expect(charactersDiffer("DIMENSIONED", "DIMENSIONED")).toBe(false);
  });

  // MIXED against either is not a clean enough mismatch to caveat every
  // finding over.
  it("does not flag a mixed set, or one it could not read", () => {
    expect(charactersDiffer("MIXED", "RENDERING")).toBe(false);
    expect(charactersDiffer("UNKNOWN", "DIMENSIONED")).toBe(false);
  });
});

describe("characterMismatchGuidance", () => {
  it("names both kinds and biases toward CHANGED rather than silence", () => {
    const g = characterMismatchGuidance("DIMENSIONED", "RENDERING");
    expect(g).toMatch(/dimensioned component drawings/);
    expect(g).toMatch(/renderings/);
    expect(g).toMatch(/prefer CHANGED or MOVED/);
  });

  // The correction that cost three runs: a suppression rule told the
  // model to stay silent, and it did -- losing the reception counter's
  // sibling findings along with the batting cage false positive. An
  // unreported change is worse than a caveated one, and the UI already
  // carries the caveat.
  it("never instructs the comparison to stay silent", () => {
    const g = characterMismatchGuidance("DIMENSIONED", "RENDERING");
    expect(g).toMatch(/Do NOT stay silent/);
    expect(g).not.toMatch(/Do not report something as REMOVED or ADDED/);
  });
});
