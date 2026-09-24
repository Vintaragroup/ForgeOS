"use client";

import { ActionForm } from "@/components/action-form";
import { decideRecostProposalAction } from "@/app/(app)/estimates/[id]/recost-actions";

// Accept or reject one proposal.
//
// One at a time on purpose. Every row here came from a model reading a
// drawing, and a bulk "accept all" is the affordance that turns a
// reviewed list into an unreviewed one.
export function RecostProposalDecision({
  estimateId,
  proposalId,
  effect,
  movesMoney,
}: {
  estimateId: string;
  proposalId: string;
  // What accepting will do, in the estimator's own units. Shown beside
  // the button rather than in a confirm dialog nobody reads.
  effect: string;
  movesMoney: boolean;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <ActionForm action={decideRecostProposalAction.bind(null, estimateId, proposalId, "ACCEPT")}>
        <button
          type="submit"
          className={`rounded-md px-3 py-1.5 text-xs font-medium text-white ${
            movesMoney ? "bg-red-700 hover:bg-red-800" : "bg-neutral-900 hover:bg-neutral-800"
          }`}
        >
          {movesMoney ? "Accept and apply" : "Accept"}
        </button>
      </ActionForm>

      <ActionForm action={decideRecostProposalAction.bind(null, estimateId, proposalId, "REJECT")}>
        <button
          type="submit"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
        >
          Reject
        </button>
      </ActionForm>

      <span className="text-xs text-neutral-500">{effect}</span>
    </div>
  );
}
