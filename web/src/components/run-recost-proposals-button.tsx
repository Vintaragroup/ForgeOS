"use client";

import { ActionForm } from "@/components/action-form";
import { proposeRecostChangesAction } from "@/app/(app)/estimates/[id]/recost-actions";

// Opt-in, like every other AI run in this app.
//
// The findings this works from do not change until somebody uploads
// another document, so running it on page load would spend a model call
// on every visit to re-derive an answer already on the screen.
export function RunRecostProposalsButton({
  estimateId,
  hasProposals,
}: {
  estimateId: string;
  hasProposals: boolean;
}) {
  return (
    <ActionForm action={proposeRecostChangesAction.bind(null, estimateId)}>
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        {/* "Again" rather than "Refresh": the second run replaces the
            first, and saying so is cheaper than someone discovering it. */}
        {hasProposals ? "Work it out again" : "Work out what they mean"}
      </button>
    </ActionForm>
  );
}
