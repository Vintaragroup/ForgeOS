"use client";

import { useMatchSelection } from "@/components/match-selection";

// A "select this whole bulk match suggestion" checkbox -- one bulk group
// covers several vendor-line indices sharing one target (see page.tsx's
// own bulkGroups comment), so checking/unchecking it moves every member
// index together via toggleMany, feeding into the same shared selection
// as the individual match-row checkboxes (match-row-checkbox.tsx) and
// the one ApplySelectedMatchesBar that acts on both.
export function MatchGroupCheckbox({ indices }: { indices: number[] }) {
  const selection = useMatchSelection();
  if (!selection) return null;

  const allSelected = indices.every((i) => selection.selected.has(i));

  return (
    <input
      type="checkbox"
      checked={allSelected}
      onChange={() => selection.toggleMany(indices)}
      aria-label="Select this group's matches"
    />
  );
}
