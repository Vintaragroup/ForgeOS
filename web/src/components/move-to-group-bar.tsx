"use client";

import { useState, useTransition } from "react";
import { Field } from "@/components/ui";
import { useBidPackageSelection } from "@/components/bid-package-selection";

// Sibling to move-selected-items-bar.tsx -- same shared selection Set, same
// "only rendered once something's checked" gating, but relocates the
// selected items to a different H2 group (EstimateSection) instead of a
// different category tab. Confirmed live as a real gap: an item filed
// under the wrong H2 ("Custom Display Wall with Oak Slatpanel" when it's
// really "BeMatrix Rental") had no way to move without deleting and
// re-adding it. Target booth is free-text with a datalist of existing
// booth labels -- blank means a project-wide group with no booth, same
// convention as "Add section"'s own Group field; target group name reuses
// an existing H2 under that booth if the name matches (case-insensitive),
// or creates a new one -- see resolveOrCreateTargetSection's own comment
// in estimate-service.ts.
export function MoveToGroupBar({
  moveSelected,
  boothLabels,
}: {
  moveSelected: (data: { groupLabel: string; sectionName: string; lineItemIds: string[] }) => Promise<void>;
  boothLabels: string[];
}) {
  const selection = useBidPackageSelection();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!selection || selection.selectedIds.size === 0) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    const groupLabel = String(formData.get("groupLabel") ?? "").trim();
    const sectionName = String(formData.get("sectionName") ?? "").trim();
    if (!sectionName) {
      setError("Name the group to move the selected items to.");
      return;
    }
    startTransition(async () => {
      try {
        await moveSelected({ groupLabel, sectionName, lineItemIds: [...selection!.selectedIds] });
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
        <div className="w-48">
          <Field label="Target booth (optional)" name="groupLabel" placeholder="blank for project-wide" list="move-to-group-booth-labels" />
          <datalist id="move-to-group-booth-labels">
            {boothLabels.map((label) => (
              <option key={label} value={label} />
            ))}
          </datalist>
        </div>
        <div className="w-56">
          <Field label="Target group name" name="sectionName" placeholder="e.g. BeMatrix Rental" required />
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Moving…" : "Move to group"}
        </button>
        <button type="button" onClick={() => selection.clear()} className="text-xs text-neutral-500 hover:underline">
          Clear selection
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
