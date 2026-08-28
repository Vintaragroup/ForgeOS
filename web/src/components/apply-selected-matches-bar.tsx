"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useMatchSelection } from "@/components/match-selection";

// Calls applySelectedVendorMatchesAction directly as a function (see
// create-bid-package-bar.tsx's own header comment for why -- the
// selected row indices live in this provider's client state, not real
// form fields). Only rendered meaningfully once the selection is
// non-empty, same as CreateBidPackageBar.
//
// Does NOT rely on the action calling redirect() -- Next's own guidance
// is that redirect's thrown control-flow exception must be called
// outside a try/catch, and this component necessarily wraps the direct
// call in one (to show a real error instead of an uncaught rejection).
// The action returns a plain result instead; this component builds the
// same ?applied=&stale= URL the rest of this file's form-based actions
// produce via redirect(), and navigates to it itself once the action
// resolves, so the "✓ Applied" flash badge behaves identically either way.
export function ApplySelectedMatchesBar({
  applySelected,
  estimateId,
  bidPackageId,
  priorAppliedIds,
}: {
  applySelected: (selectedIndices: number[]) => Promise<{ appliedLineItemIds: string[]; staleCount: number }>;
  estimateId: string;
  bidPackageId: string;
  priorAppliedIds: string[];
}) {
  const selection = useMatchSelection();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!selection || selection.selected.size === 0) return null;

  function handleClick() {
    setError(null);
    startTransition(async () => {
      try {
        const { appliedLineItemIds, staleCount } = await applySelected([...selection!.selected]);
        const appliedIds = Array.from(new Set([...priorAppliedIds, ...appliedLineItemIds]));
        const params = new URLSearchParams({ tab: "bid-packages", applied: appliedIds.join(",") });
        if (staleCount > 0) params.set("stale", String(staleCount));
        selection!.clear();
        router.push(`/estimates/${estimateId}?${params.toString()}#bid-package-${bidPackageId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't apply the selected matches.");
      }
    });
  }

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-neutral-300 bg-neutral-50 p-3">
      <span className="text-sm font-medium text-neutral-700">
        {selection.selected.size} match{selection.selected.size === 1 ? "" : "es"} selected
      </span>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Applying…" : "Apply selected"}
      </button>
      <button type="button" onClick={() => selection.clear()} className="text-xs text-neutral-500 hover:underline">
        Clear selection
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
