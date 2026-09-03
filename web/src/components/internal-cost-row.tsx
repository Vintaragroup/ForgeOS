"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

// One row in the Profitability tab's internal-costs table -- admin-only
// edit/delete, same Empty/Editing state-machine shape as this app's other
// inline editors (SectionHeadingEditor, SummaryEditor), just simpler (no
// AI-suggest step; a cost is always hand-entered).
export function InternalCostRow({
  categoryLabel,
  description,
  displayAmount,
  rawAmount,
  sectionLabel,
  categoryOptions,
  defaultCategory,
  defaultSectionId,
  updateAction,
  deleteAction,
}: {
  categoryLabel: string;
  description: string;
  // Formatted for the read-only cell (e.g. "$1,234.00").
  displayAmount: string;
  // Plain numeric string for the edit form's number input -- money()'s
  // formatting (currency symbol, thousands separators) isn't valid input
  // for type="number".
  rawAmount: string;
  sectionLabel: string;
  categoryOptions: { value: string; label: string }[];
  defaultCategory: string;
  defaultSectionId: string;
  updateAction: (formData: FormData) => void | Promise<void>;
  deleteAction: (formData: FormData) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <tr className="border-b border-neutral-100 bg-neutral-50">
        <td colSpan={5} className="py-2">
          <form
            action={async (formData) => {
              await updateAction(formData);
              setIsEditing(false);
            }}
            className="flex flex-wrap items-end gap-2"
          >
            <select name="category" defaultValue={defaultCategory} className="rounded border border-neutral-300 px-2 py-1 text-sm">
              {categoryOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {/* sectionId is fixed once a cost is created (not editable here --
                re-tying a cost to a different booth is rare enough that
                delete-and-re-add covers it without a second select here). */}
            <input type="hidden" name="sectionId" value={defaultSectionId} />
            <input
              name="description"
              defaultValue={description}
              className="rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <input
              name="amount"
              type="number"
              step="0.01"
              defaultValue={rawAmount}
              className="w-28 rounded border border-neutral-300 px-2 py-1 text-sm"
            />
            <Button variant="secondary" type="submit">
              Save
            </Button>
            <button type="button" onClick={() => setIsEditing(false)} className="text-xs text-neutral-400 hover:underline">
              Cancel
            </button>
          </form>
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-b border-neutral-100">
      <td className="py-1.5 pr-2">{categoryLabel}</td>
      <td className="py-1.5 pr-2">{description}</td>
      <td className="py-1.5 pr-2 text-neutral-500">{sectionLabel}</td>
      <td className="py-1.5 pr-2 text-right">{displayAmount}</td>
      <td className="py-1.5 pl-2 text-right whitespace-nowrap">
        <button type="button" onClick={() => setIsEditing(true)} className="mr-3 text-xs text-neutral-500 hover:text-neutral-900">
          Edit
        </button>
        <form action={deleteAction} className="inline">
          <button type="submit" className="text-xs text-red-500 hover:text-red-700">
            Remove
          </button>
        </form>
      </td>
    </tr>
  );
}
