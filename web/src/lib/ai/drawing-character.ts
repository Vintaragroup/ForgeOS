// Is this drawing a dimensioned component set, or a rendering?
//
// The two are different documents about the same booth, and a revision
// often switches between them: Full Swing's superseded drawing is a
// 7-page component sheet where 100% of extracted items carry a
// dimension, and its replacement is a 14-page rendering package where 0%
// do and eight items say the specification is not called out.
//
// That matters because a comparison between them reports representation
// as change. The batting cage is in BOTH -- "Batting cage dimensions:
// 55' x 14' x 15'10" tall" in the component set, and "chain-link fence
// batting cage enclosure" six times in the renderings -- and the first
// real comparison run reported it as ADDED, because a dimension label on
// an elevation and a photorealistic chain-link enclosure do not look
// like the same thing.
//
// So the character of each set is computed and handed to the comparison,
// which is told to expect it. A wrong finding a human has to catch is
// much worse than a caveated one, and this is the caveat.
//
// What this must NOT do is read "carries written specifications" as
// "different kind of document". Full Swing's superseded drawing is the
// SAME renderings as the original design with component specs added --
// page 1 is the identical hero view, and pages 2-7 break each component
// out with dimensions. It is a superset, not a different kind, and its
// spec pages are the most useful input the comparison has. Treating it
// as incomparable suppressed real findings for three runs. Hence the
// guidance below is a bias toward CHANGED/MOVED, never an instruction
// to stay silent.
//
// A leaf module: pure functions over plain rows, no db import.

export type DrawingCharacter = "DIMENSIONED" | "RENDERING" | "MIXED" | "UNKNOWN";

// A printed dimension: 55', 14", 16'9", 8 ft, 90 x 20.
const DIMENSION = /\d+\s*['"]|\d+\s*(?:ft|in|inch|inches|feet)\b|\d+\s*[x×]\s*\d+/i;

// The extractor's own way of saying a sheet carries no specification --
// it writes these unprompted on a rendering, which makes them a signal
// rather than a guess.
const UNSPECIFIED = /rendering|not called out|not specified|not provided|not detailed|no dimensions/i;

export interface CharacterAssessment {
  character: DrawingCharacter;
  itemCount: number;
  dimensionedCount: number;
  unspecifiedCount: number;
}

export function assessDrawingCharacter(scopeTexts: string[]): CharacterAssessment {
  const itemCount = scopeTexts.length;
  if (itemCount === 0) {
    return { character: "UNKNOWN", itemCount: 0, dimensionedCount: 0, unspecifiedCount: 0 };
  }

  const dimensionedCount = scopeTexts.filter((t) => DIMENSION.test(t)).length;
  const unspecifiedCount = scopeTexts.filter((t) => UNSPECIFIED.test(t)).length;
  const share = dimensionedCount / itemCount;

  // Thresholds are deliberately wide apart, with MIXED in between rather
  // than a single cutoff: the point is to recognise the two clear cases
  // confidently and admit uncertainty otherwise, not to force every
  // drawing into one bucket.
  const character: DrawingCharacter = share >= 0.6 ? "DIMENSIONED" : share <= 0.2 ? "RENDERING" : "MIXED";
  return { character, itemCount, dimensionedCount, unspecifiedCount };
}

// True when the two sets are different KINDS of document, which is when
// a comparison between them is most likely to report representation as
// change.
export function charactersDiffer(a: DrawingCharacter, b: DrawingCharacter): boolean {
  if (a === "UNKNOWN" || b === "UNKNOWN") return false;
  if (a === b) return false;
  // MIXED against either is not a clean mismatch worth warning about;
  // DIMENSIONED against RENDERING is.
  return (a === "DIMENSIONED" && b === "RENDERING") || (a === "RENDERING" && b === "DIMENSIONED");
}

const LABEL: Record<DrawingCharacter, string> = {
  DIMENSIONED: "dimensioned component drawings",
  RENDERING: "renderings",
  MIXED: "a mix of dimensioned drawings and renderings",
  UNKNOWN: "an unrecognised kind of drawing",
};

export function describeCharacter(c: DrawingCharacter): string {
  return LABEL[c];
}

// The sentence handed to the comparison prompt when the two sets are
// different kinds. Written as an instruction about what NOT to conclude,
// because the failure it prevents is a confident ADDED or REMOVED for
// something that was in both sets all along.
export function characterMismatchGuidance(previous: DrawingCharacter, revised: DrawingCharacter): string {
  return (
    `NOTE: the previous set is ${describeCharacter(previous)} and the revised set is ` +
    `${describeCharacter(revised)}. They may document the same booth at different levels of detail -- one set can ` +
    `be the same renderings with component specifications added. So the same object can look different between ` +
    `them without having changed: a dimensioned elevation of a batting cage and a photorealistic view of one are ` +
    `the same cage. When something is present in both but drawn differently, prefer CHANGED or MOVED over a ` +
    `REMOVED plus ADDED pair. Do NOT stay silent about a difference just because the two sets draw things ` +
    `differently -- an unreported change is worse than a caveated one.`
  );
}
