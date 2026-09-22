"use client";

import { ActionForm } from "@/components/action-form";
import { Popover, ROW_BUTTON_CLASS } from "@/components/row-popover";
import {
  assignDesignerAction,
  issueGoAheadFromDashboardAction,
  setHalfStatusFromDashboardAction,
} from "@/app/(app)/departments/graphics/row-actions";
import { PRODUCTION_STATUSES_BY_KIND, PRODUCTION_STATUS_LABELS } from "@/lib/artwork-routing-vocab";
import type { ArtworkProductionStatus, ArtworkRoutingKind } from "@/generated/prisma/enums";

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

// The shop floor's own action: move one half along. The options come from
// PRODUCTION_STATUSES_BY_KIND, so an in-house half is never offered "O.S
// sent" and an outsourced one is never offered a bare "Printing" -- the
// same table the server-side validator checks against, which is why that
// module had to stop importing `db`.
export function SetHalfStatusButton({
  routingId,
  kind,
  current,
}: {
  routingId: string;
  kind: ArtworkRoutingKind;
  current: ArtworkProductionStatus;
}) {
  return (
    <Popover label={PRODUCTION_STATUS_LABELS[current]} title="Move this half">
      {(close) => (
        <ActionForm action={setHalfStatusFromDashboardAction} className="flex flex-col gap-1.5">
          <input type="hidden" name="routingId" value={routingId} />
          {PRODUCTION_STATUSES_BY_KIND[kind].map((status) => (
            <button
              key={status}
              type="submit"
              name="productionStatus"
              value={status}
              disabled={status === current}
              onClick={() => setTimeout(close, 0)}
              className="rounded-md border border-neutral-300 px-2 py-1.5 text-left text-xs font-medium text-neutral-700 hover:border-neutral-500 disabled:cursor-default disabled:border-neutral-200 disabled:bg-neutral-50 disabled:text-neutral-400"
            >
              {PRODUCTION_STATUS_LABELS[status]}
              {status === current && " (now)"}
            </button>
          ))}
        </ActionForm>
      )}
    </Popover>
  );
}

export { ROW_BUTTON_CLASS };
