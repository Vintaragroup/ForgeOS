"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// Same shape as bid-package-selection.tsx's own provider (see its header
// comment), but scoped per bid package rather than page-wide: a match
// row's index is only meaningful within its OWN bidPackage.matchResult
// array, so BidPackageCard mounts one of these per card rather than
// sharing a single page-level selection like the line-item checkboxes do.
// Lets a reviewer hand-pick an arbitrary subset of match rows (any
// confidence, any target) and apply exactly those in one action, instead
// of being limited to one row at a time or "every high-confidence match."
interface MatchSelectionContextValue {
  selected: Set<number>;
  toggle: (index: number) => void;
  clear: () => void;
}

const MatchSelectionContext = createContext<MatchSelectionContextValue | null>(null);

export function MatchSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const toggle = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo(() => ({ selected, toggle, clear }), [selected, toggle, clear]);

  return <MatchSelectionContext.Provider value={value}>{children}</MatchSelectionContext.Provider>;
}

export function useMatchSelection() {
  return useContext(MatchSelectionContext);
}
