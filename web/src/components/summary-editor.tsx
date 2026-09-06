"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";
import { MAX_PROPOSAL_SUMMARY_LENGTH } from "@/lib/proposal-summary-limits";

// Block-level counterpart to SectionHeadingEditor's inline Empty ->
// Pending -> Approved state machine -- same three actions/shape, but for
// the three-tier Proposal PDF copy system's few-sentence paragraph body
// text (EstimateCategorySummary, EstimateSection.boothSummary/
// elementSummary) rather than a short heading replacement. One shared
// component across all three tiers (Category/Booth/Element) -- they're
// identical state machines, just bound to different actions/copy by the
// caller. Kept separate from SectionHeadingEditor since the two render in
// very different contexts (inline in an H1 vs. a full paragraph block
// under it) and share no layout. Always rendered regardless of
// summarizeOnProposal or any item-level visibility toggle -- see
// EstimateSection.boothSummary's own schema comment on why this must
// never depend on those.
export function SummaryEditor({
  summary,
  pendingSummary,
  isLocked,
  emptyHint,
  suggestAction,
  updateAction,
  rejectAction,
}: {
  summary: string | null;
  pendingSummary: string | null;
  isLocked: boolean;
  // Tier-specific placeholder copy for the Empty state, e.g. "...until
  // one is written for this booth" vs. "...for this element" vs. "...for
  // this category."
  emptyHint: string;
  suggestAction: (formData: FormData) => void | Promise<void>;
  updateAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (isLocked) {
    return summary ? <p className="mb-4 text-xs text-neutral-600 italic">{summary}</p> : null;
  }

  if (isEditing) {
    return (
      <form
        action={async (formData) => {
          await updateAction(formData);
          setIsEditing(false);
        }}
        className="mb-4 flex flex-col gap-1.5"
      >
        <textarea
          name="summary"
          defaultValue={summary ?? ""}
          autoFocus
          rows={3}
          maxLength={MAX_PROPOSAL_SUMMARY_LENGTH}
          className="w-full rounded border border-neutral-300 px-2 py-1.5 text-xs text-neutral-900"
        />
        <div className="flex items-center gap-2">
          <Button variant="secondary" type="submit">
            Save
          </Button>
          <button type="button" onClick={() => setIsEditing(false)} className="text-xs text-neutral-400 hover:underline">
            Cancel
          </button>
        </div>
      </form>
    );
  }

  if (summary) {
    return (
      <div className="mb-4 flex items-start gap-1.5">
        <p className="text-xs italic text-neutral-600">{summary}</p>
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
          title="Edit proposal summary"
          aria-label="Edit proposal summary"
        >
          ✎
        </button>
        <form action={suggestAction} className="shrink-0">
          <SubmitButton
            pendingText=""
            title="Regenerate with AI"
            aria-label="Regenerate proposal summary with AI"
            className="text-xs text-neutral-400 hover:text-neutral-700"
          >
            ↻
          </SubmitButton>
        </form>
      </div>
    );
  }

  if (pendingSummary) {
    return (
      <div className="mb-4 flex items-start gap-1.5 rounded border border-amber-200 bg-amber-50 p-2">
        <p className="text-xs italic text-neutral-600">{pendingSummary}</p>
        <form action={updateAction} className="shrink-0">
          <input type="hidden" name="summary" value={pendingSummary} />
          <button className="text-sm text-green-600 hover:text-green-800" title="Approve" aria-label="Approve suggested summary">
            ✓
          </button>
        </form>
        <form action={rejectAction} className="shrink-0">
          <button className="text-sm text-red-500 hover:text-red-700" title="Reject" aria-label="Reject suggested summary">
            ✕
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="mb-4 flex items-center gap-1.5 rounded border border-dashed border-neutral-300 p-2">
      <p className="text-xs text-neutral-400">{emptyHint}</p>
      <form action={suggestAction} className="shrink-0">
        <SubmitButton
          pendingText=""
          title="Suggest a proposal summary with AI"
          aria-label="Suggest a proposal summary with AI"
          className="text-sm font-medium text-brand-navy hover:text-brand-navy/70"
        >
          ✦
        </SubmitButton>
      </form>
    </div>
  );
}
