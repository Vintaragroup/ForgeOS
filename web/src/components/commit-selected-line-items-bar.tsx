"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useMatchSelection } from "@/components/match-selection";

// Mirrors apply-selected-matches-bar.tsx's own ApplySelectedMatchesBar
// precisely -- see that file's header comment for the full rationale
// (direct function call instead of a form submit, since selected indices
// live in MatchSelectionProvider's client state; returns a plain result
// instead of calling redirect(), since redirect()'s thrown control-flow
// exception can't be caught by a component that needs to show a real
// error on failure).
export function CommitSelectedLineItemsBar({
  commitSelected,
  estimateId,
}: {
  commitSelected: (selectedIndices: number[]) => Promise<{ rowsImported: number }>;
  estimateId: string;
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
        await commitSelected([...selection!.selected]);
        selection!.clear();
        router.push(`/estimates/${estimateId}?tab=documents`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't commit the selected line items.");
      }
    });
  }

  return (
    // fixed, not sticky -- same reasoning as ApplySelectedMatchesBar's own
    // identical choice.
    <div className="fixed inset-x-4 bottom-4 z-20 mx-auto flex max-w-2xl flex-wrap items-center gap-3 rounded-md border border-neutral-300 bg-white p-3 shadow-lg">
      <span className="text-sm font-medium text-neutral-700">
        {selection.selected.size} line item{selection.selected.size === 1 ? "" : "s"} selected
      </span>
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending}
        className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Committing…" : "Commit selected"}
      </button>
      <button type="button" onClick={() => selection.clear()} className="text-xs text-neutral-500 hover:underline">
        Clear selection
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
