"use client";

import { useMatchSelection } from "@/components/match-selection";

// A single small client island inside an otherwise server-rendered match
// table row (same split as line-item-row.tsx's own checkbox, just scoped
// to a table cell instead of the whole row -- the match table's other
// cells, dropdown, and per-row Apply form stay plain server-rendered
// forms unchanged). Renders nothing outside a MatchSelectionProvider.
export function MatchRowCheckbox({ index }: { index: number }) {
  const selection = useMatchSelection();
  if (!selection) return null;

  return (
    <input
      type="checkbox"
      checked={selection.selected.has(index)}
      onChange={() => selection.toggle(index)}
      aria-label={`Select match row ${index + 1}`}
    />
  );
}
