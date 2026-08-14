// Pure sheet-layout geometry, deliberately split out of
// cut-list-nesting-service.ts -- that module has a top-level `import {
// db } from "@/lib/db"`, so importing even one small runtime value
// (noOverlap) from it inside a client component bundles the WHOLE module
// into the browser build, which then tries to bundle the `pg` Postgres
// driver for the browser and fails (`Module not found: Can't resolve
// 'dns'`) -- confirmed live when cut-sheet-diagram-editor.tsx first
// imported noOverlap directly from cut-list-nesting-service.ts. Type-only
// imports (`import type`) are erased at compile time and don't have this
// problem -- only a real runtime import does. This file has zero
// imports of its own, so it's always safe for client code to import from
// directly.
export interface PlacedPart {
  cutListPartId: string;
  x: number;
  y: number;
  // As-placed dimensions (post any rotation) -- not the part's
  // originally entered width/length. A renderer draws straight from
  // these.
  width: number;
  height: number;
  // True if this instance's final orientation differs from how the part
  // was entered, whether because it only fit the sheet rotated or
  // because the packer chose to rotate it for a tighter fit.
  rotated: boolean;
}

// True when two placed rects genuinely don't overlap (sharing an edge is
// fine -- touching, not overlapping).
export function noOverlap(a: PlacedPart, b: PlacedPart): boolean {
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}
