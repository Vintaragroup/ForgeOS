// Which stretch of show floor a booth sits in.
//
// Her tracker carries this as a Section column, and the Seatrade April
// 2026 export shows it is purely a function of the booth number: of the 98
// rows with both a section and a numeric booth, all 98 fall inside their
// stated range. So a section is derived here, never stored on the piece --
// re-drawing a boundary re-files every affected graphic at once instead of
// leaving 300 rows saying something that is no longer true.
//
// SOP Step 8: "If a show has sections for Expo Leads, graphics are
// organized by booth in that section."

export interface BoothSection {
  id: string;
  name: string;
  boothStart: number;
  boothEnd: number;
}

// Her Booth column is hand-typed and holds more than numbers: "1585",
// "SM", "sm", and occasionally a booth with a letter. Only a plain number
// can be placed on the floor, so anything else returns null rather than
// being coerced into a section it might not be in.
export function parseBoothNumber(booth: string | null | undefined): number | null {
  const raw = `${booth ?? ""}`.trim();
  if (!raw) return null;
  // Deliberately strict: "1585" yes, "1585A" no. A booth with a suffix is
  // a sub-booth whose parent may sit on a boundary, and guessing which
  // side it falls on is worse than saying nothing.
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function sectionForBooth<T extends BoothSection>(sections: T[], booth: string | null | undefined): T | null {
  const n = parseBoothNumber(booth);
  if (n === null) return null;
  return sections.find((s) => n >= s.boothStart && n <= s.boothEnd) ?? null;
}

// Two sections covering the same booth would give that booth two answers,
// so a new or edited range is checked against the rest.
export function overlappingSection<T extends BoothSection>(
  sections: T[],
  candidate: { id?: string; boothStart: number; boothEnd: number },
): T | null {
  return (
    sections.find(
      (s) => s.id !== candidate.id && candidate.boothStart <= s.boothEnd && candidate.boothEnd >= s.boothStart,
    ) ?? null
  );
}

// "Section 2 (700-1299)", the way her own labels read -- so a coordinator
// comparing the two systems sees the same string.
export function describeSection(section: BoothSection): string {
  return `${section.name} (${section.boothStart}-${section.boothEnd})`;
}
