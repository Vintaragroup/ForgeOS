"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

// Eighth client component (see document-upload-form.tsx's header comment
// on the fourth, project-type-fields.tsx on the fifth, labor-rate-line-
// item-picker.tsx on the sixth, quantity-or-area-fields.tsx on the
// seventh). Replaces the plain text a section's H2 (or flat H4) heading
// used to render -- elementTypeForSection's own raw-name fallback (e.g.
// literally "Custom Build") told an estimator nothing about the actual
// component. isMapped sections (one of the 6 fixed banner categories --
// Wall Structure/Hardware/Wall Covering/Graphics/Labor/Shipping) keep
// that plain text unchanged, no edit affordance at all; every other
// section gets this Empty -> Pending -> Approved state machine instead:
//   Empty (no description, no pendingDescription): raw fallback text +
//     "Suggest with AI".
//   Pending (pendingDescription set, no description yet): the suggested
//     text + green check (approve) / red X (reject, back to Empty).
//   Approved (description set): the text + a pencil (manual edit) and a
//     regenerate icon (asks AI again, back to Pending).
// The three actions are passed in already bound to (estimateId,
// sectionId) by the caller (page.tsx), same as LineItemRow's own
// deleteAction/confirmAction/updateAction props -- this component stays
// free of any estimateId/sectionId plumbing of its own.
export function SectionHeadingEditor({
  fallbackLabel,
  description,
  pendingDescription,
  isMapped,
  isLocked,
  suggestAction,
  updateAction,
  rejectAction,
}: {
  fallbackLabel: string;
  description: string | null;
  pendingDescription: string | null;
  isMapped: boolean;
  isLocked: boolean;
  suggestAction: (formData: FormData) => void | Promise<void>;
  updateAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);

  if (isMapped) {
    return <>{fallbackLabel}</>;
  }

  if (isLocked) {
    return <>{description ?? fallbackLabel}</>;
  }

  if (isEditing) {
    return (
      <form
        action={async (formData) => {
          await updateAction(formData);
          setIsEditing(false);
        }}
        className="inline-flex items-center gap-1.5"
      >
        <input
          name="description"
          defaultValue={description ?? ""}
          autoFocus
          className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs font-normal normal-case"
        />
        <Button variant="secondary" type="submit">
          Save
        </Button>
        <button type="button" onClick={() => setIsEditing(false)} className="text-xs font-normal text-neutral-400 hover:underline">
          Cancel
        </button>
      </form>
    );
  }

  if (description) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {description}
        <button
          type="button"
          onClick={() => setIsEditing(true)}
          className="text-xs font-normal text-neutral-400 hover:text-neutral-700"
          title="Edit description"
          aria-label="Edit description"
        >
          ✎
        </button>
        <form action={suggestAction} className="inline">
          <button
            className="text-xs font-normal text-neutral-400 hover:text-neutral-700"
            title="Regenerate with AI"
            aria-label="Regenerate description with AI"
          >
            ↻
          </button>
        </form>
      </span>
    );
  }

  if (pendingDescription) {
    return (
      <span className="inline-flex items-center gap-1.5 font-normal italic text-neutral-500">
        {pendingDescription}
        <form action={updateAction} className="inline">
          <input type="hidden" name="description" value={pendingDescription} />
          <button className="text-sm not-italic text-green-600 hover:text-green-800" title="Approve" aria-label="Approve suggested description">
            ✓
          </button>
        </form>
        <form action={rejectAction} className="inline">
          <button className="text-sm not-italic text-red-500 hover:text-red-700" title="Reject" aria-label="Reject suggested description">
            ✕
          </button>
        </form>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      {fallbackLabel}
      <form action={suggestAction} className="inline">
        <button className="text-xs font-normal text-brand-navy hover:underline" title="Suggest a description with AI">
          Suggest with AI
        </button>
      </form>
    </span>
  );
}
