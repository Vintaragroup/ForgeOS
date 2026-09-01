"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { SubmitButton } from "@/components/submit-button";

// Eighth client component (see document-upload-form.tsx's header comment
// on the fourth, project-type-fields.tsx on the fifth, labor-rate-line-
// item-picker.tsx on the sixth, quantity-or-area-fields.tsx on the
// seventh). Replaces the plain text a heading used to render -- both the
// section H2/flat H4 (elementTypeForSection's own raw-name fallback, e.g.
// literally "Custom Build") and the booth H1 (the raw groupLabel, e.g.
// "Section 428 - Booth - Page 9") tell an estimator nothing about the
// actual component/booth. isMapped sections (one of the 6 fixed banner
// categories -- Wall Structure/Hardware/Wall Covering/Graphics/Labor/
// Shipping -- never applies to a booth H1, only a section H2) keep plain
// text unchanged, no edit affordance at all; every other heading gets
// this Empty -> Pending -> Approved state machine instead:
//   Empty (no description, no pendingDescription): raw fallback text +
//     a "suggest" icon.
//   Pending (pendingDescription set, no description yet): the suggested
//     text + green check (approve) / red X (reject, back to Empty).
//   Approved (description set): the text + a pencil (manual edit) and a
//     regenerate icon (asks AI again, back to Pending).
// The suggest/regenerate icons are real <SubmitButton>s (not plain
// buttons) specifically so the OpenAI round-trip shows its own spinner --
// the plain-button version of this shipped first and gave no feedback at
// all while a suggestion was generating.
// The three actions are passed in already bound to whatever identifies
// the target (sectionId for a section heading, (versionId, groupLabel)
// for a booth heading) by the caller (page.tsx), same as LineItemRow's
// own deleteAction/confirmAction/updateAction props -- this component
// stays free of any of that plumbing itself.
export function SectionHeadingEditor({
  fallbackLabel,
  description,
  pendingDescription,
  isMapped,
  isLocked,
  theme = "light",
  suggestAction,
  updateAction,
  rejectAction,
}: {
  fallbackLabel: string;
  description: string | null;
  pendingDescription: string | null;
  isMapped: boolean;
  isLocked: boolean;
  // "dark" is for the booth H1 heading, rendered on a dark bg-neutral-900
  // banner -- the default "light" palette (neutral-400/700 text) would be
  // unreadable there.
  theme?: "light" | "dark";
  suggestAction: (formData: FormData) => void | Promise<void>;
  updateAction: (formData: FormData) => void | Promise<void>;
  rejectAction: (formData: FormData) => void | Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const dark = theme === "dark";

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
          className={`rounded border px-1.5 py-0.5 text-xs font-normal normal-case ${
            dark ? "border-neutral-600 bg-neutral-800 text-white" : "border-neutral-300 text-neutral-900"
          }`}
        />
        <Button variant="secondary" type="submit">
          Save
        </Button>
        <button
          type="button"
          onClick={() => setIsEditing(false)}
          className={`text-xs font-normal hover:underline ${dark ? "text-neutral-400 hover:text-white" : "text-neutral-400"}`}
        >
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
          className={`text-xs font-normal ${dark ? "text-neutral-400 hover:text-white" : "text-neutral-400 hover:text-neutral-700"}`}
          title="Edit description"
          aria-label="Edit description"
        >
          ✎
        </button>
        <form action={suggestAction} className="inline">
          <SubmitButton
            pendingText=""
            title="Regenerate with AI"
            aria-label="Regenerate description with AI"
            className={`text-xs font-normal ${dark ? "text-neutral-400 hover:text-white" : "text-neutral-400 hover:text-neutral-700"}`}
          >
            ↻
          </SubmitButton>
        </form>
      </span>
    );
  }

  if (pendingDescription) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 font-normal italic ${dark ? "text-neutral-300" : "text-neutral-500"}`}
      >
        {pendingDescription}
        <form action={updateAction} className="inline">
          <input type="hidden" name="description" value={pendingDescription} />
          <button
            className={`text-sm not-italic ${dark ? "text-green-400 hover:text-green-300" : "text-green-600 hover:text-green-800"}`}
            title="Approve"
            aria-label="Approve suggested description"
          >
            ✓
          </button>
        </form>
        <form action={rejectAction} className="inline">
          <button
            className={`text-sm not-italic ${dark ? "text-red-400 hover:text-red-300" : "text-red-500 hover:text-red-700"}`}
            title="Reject"
            aria-label="Reject suggested description"
          >
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
        <SubmitButton
          pendingText=""
          title="Suggest a description with AI"
          aria-label="Suggest a description with AI"
          className={`text-sm font-normal ${dark ? "text-neutral-300 hover:text-white" : "text-brand-navy hover:text-brand-navy/70"}`}
        >
          ✦
        </SubmitButton>
      </form>
    </span>
  );
}
