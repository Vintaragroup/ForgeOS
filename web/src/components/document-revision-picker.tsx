"use client";

import { ActionForm } from "@/components/action-form";
import { Popover, ROW_BUTTON_CLASS } from "@/components/row-popover";
import { setDocumentSupersedesAction } from "@/app/(app)/opportunities/[id]/documents/actions";

// "This replaces …" on a document row.
//
// The ask was to tag documents V1 and V2 by hand. This records which
// document replaces which instead, and the label is derived from that --
// so nobody maintains a number, and the third revision cannot end up
// called V2 alongside the second.
export function DocumentRevisionPicker({
  opportunityId,
  documentId,
  currentSupersedesId,
  candidates,
}: {
  opportunityId: string;
  documentId: string;
  currentSupersedesId: string | null;
  // Every other document on the opportunity. The service re-checks this
  // list server-side, so a stale form cannot link across deals.
  candidates: { id: string; filename: string }[];
}) {
  const current = candidates.find((c) => c.id === currentSupersedesId);
  return (
    <Popover label={current ? "Replaces…" : "Link"} title="Which document does this replace?">
      {(close) => (
        <ActionForm
          action={setDocumentSupersedesAction.bind(null, opportunityId, documentId)}
          className="flex flex-col gap-2"
        >
          {candidates.length === 0 ? (
            <p className="text-[11px] leading-snug text-neutral-500">
              There is nothing else on this opportunity for it to replace yet.
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-snug text-neutral-500">
                Version numbers come from this link, so there is nothing to type and nothing to keep in step.
              </p>
              <select
                name="supersedesId"
                defaultValue={currentSupersedesId ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              >
                <option value="">— replaces nothing —</option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.filename}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                onClick={() => setTimeout(close, 0)}
                className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white"
              >
                Save
              </button>
            </>
          )}
        </ActionForm>
      )}
    </Popover>
  );
}

export { ROW_BUTTON_CLASS };
