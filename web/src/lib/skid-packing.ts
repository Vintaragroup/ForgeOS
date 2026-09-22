// The order a crate is physically loaded in. SOP Step 8.
//
// Split out of skid-service.ts, which imports `db`. This is pure ranking
// over a material name, wanted by the Graphics dashboard's shipping tab
// and by anything that renders a packing list, and neither should have to
// pull Prisma in to sort a list. skid-service re-exports both, so existing
// callers are unaffected.

// "PVC panels are packed first due to weight followed by lighter material
// such as foamboard and vinyl." Lower sorts earlier, so a packing list
// comes out in the order someone should physically load it.
const PACKING_WEIGHT_ORDER: { match: RegExp; rank: number }[] = [
  { match: /pvc/i, rank: 0 },
  { match: /acrylic|plexi/i, rank: 1 },
  { match: /ultraboard|foam\s*board|foamboard/i, rank: 2 },
  { match: /vinyl/i, rank: 3 },
  { match: /fabric|seg/i, rank: 4 },
];

export function packingRank(material: string | null | undefined): number {
  const m = `${material ?? ""}`;
  for (const { match, rank } of PACKING_WEIGHT_ORDER) if (match.test(m)) return rank;
  // Unknown materials go last rather than first: guessing something is
  // heavy enough to sit at the bottom of a crate is the costly direction
  // to be wrong in.
  return PACKING_WEIGHT_ORDER.length;
}

// Heaviest first, then by piece so the list is stable between reads.
export function sortForPacking<T extends { material: string | null; graphicCode: string | null }>(pieces: T[]): T[] {
  return [...pieces].sort(
    (a, b) => packingRank(a.material) - packingRank(b.material) || (a.graphicCode ?? "").localeCompare(b.graphicCode ?? ""),
  );
}

