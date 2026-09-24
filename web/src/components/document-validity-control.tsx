"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import { setDocumentValidityAction } from "@/app/(app)/opportunities/[id]/documents/actions";
import type { DocumentValidityValue } from "@/lib/document-validity";

// Marking a source dead, and showing when it is.
//
// The wording here does real work. Withdrawing a document removes
// nothing from the estimate -- its line items stay and keep costing
// money -- and a control that read "remove" or "delete" would promise
// something it does not do, on a job where almost nothing is actually
// being deleted.

export function DocumentValidityControl({
  opportunityId,
  documentId,
  filename,
  validity,
  validityNote,
  supersededByFilename,
}: {
  opportunityId: string;
  documentId: string;
  filename: string;
  validity: DocumentValidityValue;
  validityNote: string | null;
  supersededByFilename: string | null;
}) {
  const [open, setOpen] = useState(false);

  // Derived, not stored -- the chain is the truth. Nothing to offer
  // here: a superseded document already has its replacement, and saying
  // so is enough.
  if (supersededByFilename && validity !== "WITHDRAWN") {
    return (
      <span className="shrink-0 rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600" title={`Replaced by ${supersededByFilename}`}>
        superseded
      </span>
    );
  }

  if (validity === "WITHDRAWN") {
    return (
      <ActionForm
        action={setDocumentValidityAction.bind(null, opportunityId, documentId)}
        className="flex shrink-0 items-center gap-1.5"
      >
        <input type="hidden" name="validity" value="CURRENT" />
        <span
          className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800"
          title={validityNote ?? undefined}
        >
          not a valid source
        </span>
        <button type="submit" className="text-xs text-neutral-500 hover:underline" title="Make this a valid source again">
          undo
        </button>
      </ActionForm>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Mark this document as no longer a valid source -- its line items stay in the estimate"
        className="shrink-0 text-xs text-neutral-500 hover:underline"
      >
        No longer valid
      </button>
    );
  }

  return (
    <ActionForm
      action={setDocumentValidityAction.bind(null, opportunityId, documentId)}
      resetOnSuccess
      onSuccess={() => setOpen(false)}
      className="flex flex-col gap-1.5 rounded-md border border-neutral-200 bg-neutral-50 p-2"
    >
      <input type="hidden" name="validity" value="WITHDRAWN" />
      <p className="text-xs text-neutral-600">
        Mark {filename} as no longer a valid source. Its line items stay in the estimate — they&apos;re flagged for
        the re-cost review, not removed.
      </p>
      <input
        name="validityNote"
        required
        placeholder="Why? e.g. Fuse is no longer supplying AV on this job"
        className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
      />
      <div className="flex items-center gap-2">
        <button type="submit" className="rounded-md bg-brand-black px-2.5 py-1 text-xs font-medium text-white">
          Mark not valid
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-xs text-neutral-500 hover:underline">
          Cancel
        </button>
      </div>
    </ActionForm>
  );
}
