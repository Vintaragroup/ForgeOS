"use client";

import { ActionForm } from "@/components/action-form";
import { acceptRecommendedRecostsAction } from "@/app/(app)/estimates/[id]/recost-actions";

// The one bulk affordance, and it says exactly what it will touch.
//
// A count and a number, not "accept all": an estimator about to move
// $47,000 across 56 rows should read both before clicking, and should be
// able to see from the label that the removals are not included.
export function AcceptRecommendedButton({
  estimateId,
  count,
  costDelta,
}: {
  estimateId: string;
  count: number;
  costDelta: number;
}) {
  const money = Math.abs(costDelta).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

  return (
    <ActionForm action={acceptRecommendedRecostsAction.bind(null, estimateId)}>
      <button
        type="submit"
        className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800"
      >
        Apply all {count} re-costs ({costDelta < 0 ? "−" : "+"}
        {money})
      </button>
    </ActionForm>
  );
}
