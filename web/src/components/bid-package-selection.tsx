"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

// Eighth client component (see line-item-row.tsx's header comment on
// the seventh). Lets a user select a freeform, cross-category set of
// line items for whichever bulk action applies -- originally just
// grouping into a BidPackage (create-bid-package-bar.tsx), now also
// bulk-recategorizing (move-selected-items-bar.tsx). Kept as one shared
// selection rather than a separate Set per consumer: checking items
// doesn't commit to anything until one of the bars' actions is actually
// submitted, so there's no ambiguity in letting both read the same Set
// and appear together whenever it's non-empty. The category board
// (LineItemsTab's inner Tabs) keeps every category's content mounted
// simultaneously, just hidden-toggled (see components/tabs.tsx's own
// header comment), so a plain Set in this provider survives switching
// between category tabs without needing anything heavier (URL state,
// a server round-trip) to persist it.
//
// Default context value is null, not a real provider -- LineItemRow
// calls useBidPackageSelection() unconditionally and treats a null
// context as "no selector active," so it renders identically whether or
// not a page wraps its category board in a BidPackageSelectionProvider.
interface BidPackageSelectionContextValue {
  selectedIds: Set<string>;
  toggle: (lineItemId: string) => void;
  clear: () => void;
}

const BidPackageSelectionContext = createContext<BidPackageSelectionContextValue | null>(null);

export function BidPackageSelectionProvider({ children }: { children: ReactNode }) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggle = useCallback((lineItemId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(lineItemId)) next.delete(lineItemId);
      else next.add(lineItemId);
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelectedIds(new Set()), []);

  const value = useMemo(() => ({ selectedIds, toggle, clear }), [selectedIds, toggle, clear]);

  return <BidPackageSelectionContext.Provider value={value}>{children}</BidPackageSelectionContext.Provider>;
}

export function useBidPackageSelection() {
  return useContext(BidPackageSelectionContext);
}
