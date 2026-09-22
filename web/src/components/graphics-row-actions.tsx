"use client";

import { ActionForm } from "@/components/action-form";
import { Popover, ROW_BUTTON_CLASS } from "@/components/row-popover";
import { assignDesignerAction, issueGoAheadFromDashboardAction } from "@/app/(app)/departments/graphics/row-actions";

// The buttons on a Graphics queue row. Same popover Sales uses, same
// reason: work the queue top to bottom without losing your place.

export function AssignDesignerButton({
  artworkOrderId,
  designers,
  currentDesignerId,
}: {
  artworkOrderId: string;
  designers: { id: string; name: string }[];
  currentDesignerId: string | null;
}) {
  const current = designers.find((d) => d.id === currentDesignerId);
  return (
    // The label carries the current state, so a manager scanning the queue
    // can see who has what without opening each popover.
    <Popover label={current ? current.name.split(/\s+/)[0] : "Assign"} title="Assign a designer">
      {(close) => (
        <ActionForm action={assignDesignerAction} className="flex flex-col gap-2">
          <input type="hidden" name="artworkOrderId" value={artworkOrderId} />
          {designers.length === 0 ? (
            <p className="text-[11px] leading-snug text-neutral-500">
              Nobody is in the Design department yet, so there is no one to assign.
            </p>
          ) : (
            <>
              <select
                name="designerId"
                defaultValue={currentDesignerId ?? ""}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              >
                <option value="">Unassigned</option>
                {designers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
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

export function IssueGoAheadButton({ artworkOrderId }: { artworkOrderId: string }) {
  return (
    // Behind a confirm rather than a bare button: this one emails the
    // vendor and tells them to start printing.
    <Popover label="Send to print" title="Issue the go-ahead?">
      {(close) => (
        <ActionForm action={issueGoAheadFromDashboardAction} className="flex flex-col gap-2">
          <input type="hidden" name="artworkOrderId" value={artworkOrderId} />
          <p className="text-[11px] leading-snug text-neutral-500">
            The client has signed off. This emails the vendor and moves the piece into production.
          </p>
          <button
            type="submit"
            onClick={() => setTimeout(close, 0)}
            className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white"
          >
            Issue go-ahead
          </button>
        </ActionForm>
      )}
    </Popover>
  );
}

export { ROW_BUTTON_CLASS };
