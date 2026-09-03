"use client";

import { useState, useTransition } from "react";
import { Field } from "@/components/ui";
import { useBidPackageSelection } from "@/components/bid-package-selection";

// Sentinel select value for "type a brand-new group name" -- never a real
// section name, so it can't collide with one.
const NEW_GROUP_VALUE = "__new__";

// Sibling to move-selected-items-bar.tsx -- same shared selection Set, same
// "only rendered once something's checked" gating, but relocates the
// selected items to a different H2 group (EstimateSection) instead of a
// different category tab. Confirmed live as a real gap: an item filed
// under the wrong H2 ("Custom Display Wall with Oak Slatpanel" when it's
// really "BeMatrix Rental") had no way to move without deleting and
// re-adding it.
//
// Deliberately scoped to the selected items' own H1 parent -- never a
// free-text target booth -- per the estimator's own correction: a line
// item only ever needs to move between H2 groups of the SAME booth (or
// the same project-wide bucket), never to an unrelated booth entirely
// (that's what moving the whole booth, or the per-section "Move section"
// dropdown, is for). The dropdown lists every other H2 already under that
// one parent; "+ Create new group" still allows a brand-new H2 there,
// reusing an existing one by name if it happens to match (case-
// insensitive) -- see resolveOrCreateTargetSection's own comment in
// estimate-service.ts.
export function MoveToGroupBar({
  moveSelected,
  lineItemGroupLabels,
  sectionNamesByGroupLabel,
}: {
  moveSelected: (data: { groupLabel: string; sectionName: string; lineItemIds: string[] }) => Promise<void>;
  // Every line item's current booth (groupLabel) -- null for a
  // project-wide item with no booth. Used to figure out, from whichever
  // items are currently checked, which one H1 parent (if any single one)
  // they all share.
  lineItemGroupLabels: Record<string, string | null>;
  // Every H1's own H2 group names -- keyed by groupLabel, with "" as the
  // project-wide bucket's key (mirrors lineItemGroupLabels' null the only
  // way a plain object key can).
  sectionNamesByGroupLabel: Record<string, string[]>;
}) {
  const selection = useBidPackageSelection();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState(NEW_GROUP_VALUE);
  const [newName, setNewName] = useState("");

  const selectedIds = selection ? [...selection.selectedIds] : [];

  // Only well-defined when every checked item currently shares exactly
  // one booth (including every item being project-wide, i.e. groupLabel
  // null) -- "the current item's H1 parent" has no single meaning
  // otherwise. Cheap enough (a handful of checked ids) to recompute
  // plainly every render rather than memoize.
  const sharedGroupLabels = new Set(selectedIds.map((id) => lineItemGroupLabels[id] ?? null));
  const sharedGroupLabel = sharedGroupLabels.size === 1 ? [...sharedGroupLabels][0] : undefined;

  if (!selection || selection.selectedIds.size === 0) return null;

  if (sharedGroupLabel === undefined) {
    return (
      <div className="rounded-md border border-neutral-300 bg-white p-4 shadow-lg">
        <p className="text-sm text-neutral-500">
          Select items from a single booth (or a single project-wide group) to move them between its groups.
        </p>
      </div>
    );
  }

  const siblingNames = sectionNamesByGroupLabel[sharedGroupLabel ?? ""] ?? [];

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const sectionName = choice === NEW_GROUP_VALUE ? newName.trim() : choice;
    if (!sectionName) {
      setError("Name the new group, or pick an existing one.");
      return;
    }
    startTransition(async () => {
      try {
        await moveSelected({ groupLabel: sharedGroupLabel ?? "", sectionName, lineItemIds: selectedIds });
        selection!.clear();
        setChoice(NEW_GROUP_VALUE);
        setNewName("");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't move these line items.");
      }
    });
  }

  return (
    <div className="rounded-md border border-neutral-300 bg-white p-4 shadow-lg">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="text-sm font-medium text-neutral-700">
          {selectedIds.length} item{selectedIds.length === 1 ? "" : "s"} selected
          <span className="block text-xs font-normal text-neutral-500">
            {sharedGroupLabel ? sharedGroupLabel : "Project-wide (no booth)"}
          </span>
        </div>
        <div className="w-56">
          <label className="text-sm font-medium text-neutral-700" htmlFor="move-to-group-choice">
            Move to group
          </label>
          <select
            id="move-to-group-choice"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="mt-1 block w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-500"
          >
            {siblingNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
            <option value={NEW_GROUP_VALUE}>+ Create new group…</option>
          </select>
        </div>
        {choice === NEW_GROUP_VALUE && (
          <div className="w-56">
            <Field
              label="New group name"
              name="newGroupName"
              value={newName}
              onChange={setNewName}
              placeholder="e.g. BeMatrix Rental"
            />
          </div>
        )}
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
