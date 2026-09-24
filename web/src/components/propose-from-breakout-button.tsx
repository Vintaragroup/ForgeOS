"use client";

import { ActionForm } from "@/components/action-form";
import { proposeFromCostBreakoutAction } from "@/app/(app)/estimates/[id]/recost-actions";

// Free to run, unlike the AI stage: this reads two spreadsheets and
// joins on a key the import itself created. Re-run it as often as the
// documents change.
export function ProposeFromBreakoutButton({ estimateId }: { estimateId: string }) {
  return (
    <ActionForm action={proposeFromCostBreakoutAction.bind(null, estimateId)}>
      <button
        type="submit"
        className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        Turn these into proposals
      </button>
    </ActionForm>
  );
}
