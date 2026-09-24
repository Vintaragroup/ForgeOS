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

export type DrawingChangeKind = "REMOVED" | "ADDED" | "CHANGED";

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
