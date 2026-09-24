"use client";

import { ActionForm } from "@/components/action-form";
import { acceptRemovalsForElementAction } from "@/app/(app)/estimates/[id]/recost-actions";
import { money } from "@/lib/money-format";

// One element, one decision.
//
// The rows are still listed underneath and each still applies through
// the same single path, so each keeps its own audit row and its own way
// back. What is collapsed is the clicking, not the record.
export function RemoveElementButton({
  estimateId,
  element,
  count,
  cost,
}: {
  estimateId: string;
  element: string;
  count: number;
  cost: number;
}) {
  return (
    <ActionForm action={acceptRemovalsForElementAction.bind(null, estimateId, element)}>
      <button
        type="submit"
        className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
      >
        Remove all {count} rows (−{money(cost)})
      </button>
    </ActionForm>
  );
}
