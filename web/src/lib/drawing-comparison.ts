// The shape of a drawing-vs-drawing comparison.
//
// A leaf: types only, no db import, so the card that renders a
// comparison can be a client component without pulling Prisma into the
// browser bundle. Same split as document-diff.ts (types and pure
// functions) against document-service.ts (the queries) -- and it exists
// because getting it wrong failed the build with "Can't resolve 'dns'",
// which is pg arriving in a client component.
//
// The service that produces one of these is ai/drawing-comparison-service.ts.

import type { DrawingCharacter } from "@/lib/ai/drawing-character";

// MOVED matters as much as the other three. A relocated item still
// costs money -- possibly a different amount, if it now hangs off a
// cage rather than a grid -- so reporting it as REMOVED reads as scope
// leaving the job when it has not. Full Swing's hanging banners moved
// from a ceiling grid to the batting cage structure and one comparison
// run reported only the removal half.
export type DrawingChangeKind = "REMOVED" | "ADDED" | "CHANGED" | "MOVED";

export interface DrawingChangeFinding {
  kind: DrawingChangeKind;
  // Named the way an exhibit estimator names things -- "reception
  // counter", "hanging sign" -- because these are matched against booths
  // with names like that.
  subject: string;
  detail: string;
  // Which sheet it is visible on, so a finding can be checked rather
  // than believed. Null on the side it does not appear.
  previousPage: number | null;
  revisedPage: number | null;
}

export interface DrawingComparison {
  previousDocumentId: string;
  previousFilename: string;
  revisedDocumentId: string;
  revisedFilename: string;
  findings: DrawingChangeFinding[];
  // Recorded so a thin result reads as "few pages were compared" rather
  // than "little changed".
  previousPagesCompared: number;
  revisedPagesCompared: number;
  // True when the two drawings are different KINDS -- a dimensioned
  // component set against a rendering package. Their findings are
  // softer evidence than they look, because the same object drawn two
  // ways can read as removed and added. See drawing-character.ts.
  charactersMismatched: boolean;
  previousCharacter: DrawingCharacter;
  revisedCharacter: DrawingCharacter;
  comparedAt: string;
}


// Drops a REMOVED finding when the same subject is also reported as
// MOVED or CHANGED.
//
// The model emits both for one subject: Full Swing's hanging banners
// came back as "[REMOVED] no longer present" AND "[MOVED] now hang from
// the batting cage structure". Both cannot be true, and the removal is
// the one that is wrong -- it is also the expensive one to believe,
// because relocated scope read as removed is cost cut from a job that
// still has it.
//
// Done here rather than by prompting. The prompt already says to search
// every page before calling something REMOVED, and it did search -- that
// is where the MOVED came from. Three attempts at tightening this prompt
// each cost real findings elsewhere, so this is the deterministic fix:
// a contradiction one pass can see is not worth another round of asking
// nicely.
export function dropContradictedRemovals(findings: DrawingChangeFinding[]): DrawingChangeFinding[] {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

  const stillPresent = new Set(
    findings.filter((f) => f.kind === "MOVED" || f.kind === "CHANGED").map((f) => normalize(f.subject)),
  );

  return findings.filter((f) => !(f.kind === "REMOVED" && stillPresent.has(normalize(f.subject))));
}
