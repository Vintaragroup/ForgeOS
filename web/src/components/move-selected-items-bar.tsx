"use client";

import { useState, useTransition } from "react";
import { SelectField } from "@/components/ui";
import { useBidPackageSelection } from "@/components/bid-package-selection";

// Companion to create-bid-package-bar.tsx (see its own header comment
// for why this calls the action directly rather than binding it to a
// <form action>) -- both read from the same selection Set, so checking
// items surfaces two bars at once and an estimator picks whichever bulk
// action applies. Exists for exactly the case this taxonomy rework
// surfaced live: a handful of items on an otherwise-correct booth got
// mis-typed at import (e.g. "Flooring" instead of "Structure") and
// needed moving individually rather than the section's other items
// alongside them -- previously that meant editing each line item one at
// a time. Only rendered meaningfully once the selection Set is non-empty.
export function MoveSelectedItemsBar({
  moveSelected,
  categoryOptions,
}: {
  moveSelected: (data: { category: string; lineItemIds: string[] }) => Promise<void>;
  categoryOptions: { value: string; label: string }[];
}) {
  const selection = useBidPackageSelection();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!selection || selection.selectedIds.size === 0) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    const category = String(formData.get("category") ?? "").trim();
    if (!category) {
      setError("Choose a category to move the selected items to.");
      return;
    }
    startTransition(async () => {
      try {
        await moveSelected({ category, lineItemIds: [...selection!.selectedIds] });
        selection!.clear();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't move these line items.");
      }
    });
  }

  return (
    <div className="rounded-md border border-neutral-300 bg-white p-4 shadow-lg">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="text-sm font-medium text-neutral-700">
          {selection.selectedIds.size} item{selection.selectedIds.size === 1 ? "" : "s"} selected
        </div>
        <div className="w-56">
          <SelectField label="Move to category" name="category" options={categoryOptions} />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Moving…" : "Move selected items"}
        </button>
        <button type="button" onClick={() => selection.clear()} className="text-xs text-neutral-500 hover:underline">
          Clear selection
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
