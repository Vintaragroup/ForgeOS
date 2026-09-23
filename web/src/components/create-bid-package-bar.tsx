"use client";

import { useState, useTransition } from "react";
import { Field } from "@/components/ui";
import { useBidPackageSelection } from "@/components/bid-package-selection";

// Ninth client component (see bid-package-selection.tsx's header
// comment on the eighth). Only rendered meaningfully once the selection
// Set is non-empty. Calls createBidPackageAction directly as a function
// rather than binding it to a <form action> -- the selected line-item
// ids live in the provider's client state, not in real form fields, so
// there's nothing for a bound form action to read them from. Server
// Actions are plain async functions and are callable either way; this
// is a direct call, not a form submission.
export function CreateBidPackageBar({
  createBidPackage,
  trades,
}: {
  createBidPackage: (data: {
    name: string;
    vendorName?: string;
    tradeCode?: string;
    lineItemIds: string[];
  }) => Promise<void>;
  // The department codes a package can be tagged with -- AV, Graphics,
  // Rigging. Passed in rather than fetched here so this stays a client
  // component with no data access of its own.
  trades: { code: string; name: string }[];
}) {
  const selection = useBidPackageSelection();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (!selection || selection.selectedIds.size === 0) return null;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const vendorName = String(formData.get("vendorName") ?? "").trim();
    const tradeCode = String(formData.get("tradeCode") ?? "").trim();
    if (!name) {
      setError("Name this bid package before creating it.");
      return;
    }
    startTransition(async () => {
      try {
        await createBidPackage({ name, vendorName, tradeCode, lineItemIds: [...selection!.selectedIds] });
        selection!.clear();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't create this bid package.");
      }
    });
  }

  return (
    <div className="rounded-md border border-neutral-300 bg-white p-4 shadow-lg">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="text-sm font-medium text-neutral-700">
          {selection.selectedIds.size} item{selection.selectedIds.size === 1 ? "" : "s"} selected
        </div>
        <div className="flex-1 min-w-[10rem]">
          <Field label="Bid package name" name="name" placeholder="e.g. Scaffolding, Platforms & Truss" required />
        </div>
        <div className="w-48">
          <Field label="Vendor (optional)" name="vendorName" placeholder="e.g. ShowRig" />
        </div>
        {/* Which trade is being bid. Optional, because a package that
            spans trades is a real thing and forcing a single code would
            just get a wrong one. */}
        <div className="w-40">
          <label className="mb-1 block text-sm font-medium text-neutral-700">Trade (optional)</label>
          <select
            name="tradeCode"
            defaultValue=""
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 outline-none focus:border-neutral-500"
          >
            <option value="">— none —</option>
            {trades.map((t) => (
              <option key={t.code} value={t.code}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={isPending}
          className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Creating…" : "Create bid package"}
        </button>
        <button type="button" onClick={() => selection.clear()} className="text-xs text-neutral-500 hover:underline">
          Clear selection
        </button>
      </form>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
