"use client";

import { useState } from "react";
import { ActionForm } from "@/components/action-form";
import {
  recordProposalStatusAction,
  requestProposalRevisionsAction,
} from "@/app/(app)/proposals/actions";
import type { ProposalStatus } from "@/generated/prisma/enums";

// Where a proposal stands with the client, and what you can do about it.
//
// This replaces a row that read "Proposal cmtiu6m2k ... Sent" -- an opaque
// id and a grey word, with no date on it even though the opportunity page
// two clicks away knew the thing had been sitting unsigned for 14 days,
// and no action on it at all. The only forward move from here used to be
// "Start change order".

const STATUS_LABELS: Record<ProposalStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent to client",
  UNDER_REVIEW: "Client reviewing",
  REVISIONS_REQUESTED: "Revisions requested",
  SIGNED: "Signed",
  DECLINED: "Declined",
};

const STATUS_TONE: Record<ProposalStatus, string> = {
  DRAFT: "bg-neutral-100 text-neutral-700",
  SENT: "bg-blue-50 text-blue-800",
  UNDER_REVIEW: "bg-amber-50 text-amber-900",
  REVISIONS_REQUESTED: "bg-amber-50 text-amber-900",
  SIGNED: "bg-green-50 text-green-800",
  DECLINED: "bg-neutral-100 text-neutral-600",
};

export interface ProposalEventView {
  id: string;
  toStatus: ProposalStatus;
  note: string | null;
  byName: string | null;
  managerConsulted: boolean;
  at: string;
}

// The attestation. A manager moves a proposal on their own authority;
// everyone else confirms they spoke to one first, and that claim is
// recorded on the event rather than just gating the click.
function ManagerConsent({ required }: { required: boolean }) {
  if (!required) return null;
  return (
    <label className="flex items-start gap-2 text-xs text-neutral-600">
      <input type="checkbox" name="managerConsulted" className="mt-0.5 h-4 w-4 rounded border-neutral-300" />
      <span>I&apos;ve discussed this with my manager or the department head.</span>
    </label>
  );
}

export function ProposalStatusPanel({
  proposalId,
  status,
  sentAt,
  signedAt,
  signedByName,
  events,
  requiresManagerConsent,
  nextStatuses,
}: {
  proposalId: string;
  status: ProposalStatus;
  sentAt: string | null;
  signedAt: string | null;
  signedByName: string | null;
  events: ProposalEventView[];
  // False for a manager -- they carry the authority themselves.
  requiresManagerConsent: boolean;
  // Computed server-side from PROPOSAL_TRANSITIONS, so the buttons can
  // never offer a move the service would refuse.
  nextStatuses: ProposalStatus[];
}) {
  const [open, setOpen] = useState<ProposalStatus | null>(null);
  const canRequestRevisions = nextStatuses.includes("REVISIONS_REQUESTED");

  return (
    <div className="mt-4 border-t border-neutral-200 pt-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_TONE[status]}`}>
          {STATUS_LABELS[status]}
        </span>
        <span className="text-xs text-neutral-500">
          {signedAt
            ? `Signed ${new Date(signedAt).toLocaleDateString()}${signedByName ? ` by ${signedByName}` : ""}`
            : sentAt
              ? `Sent ${new Date(sentAt).toLocaleDateString()}`
              : "Not sent yet"}
        </span>
      </div>

      {nextStatuses.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {canRequestRevisions && (
            <button
              type="button"
              onClick={() => setOpen(open === "REVISIONS_REQUESTED" ? null : "REVISIONS_REQUESTED")}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            >
              Request updated costing
            </button>
          )}
          {nextStatuses
            .filter((s) => s !== "REVISIONS_REQUESTED")
            .map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setOpen(open === s ? null : s)}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Mark {STATUS_LABELS[s].toLowerCase()}
              </button>
            ))}
        </div>
      )}

      {open === "REVISIONS_REQUESTED" && (
        <ActionForm
          action={requestProposalRevisionsAction.bind(null, proposalId)}
          className="mt-3 flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
        >
          <p className="text-xs text-amber-900">
            Records what the client asked for and opens the next version for re-costing. The sent version stays
            exactly as it is — it&apos;s the record of what they actually received.
          </p>
          <textarea
            name="note"
            required
            rows={2}
            placeholder="What did the client ask to change?"
            className="resize-none rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <ManagerConsent required={requiresManagerConsent} />
          <div>
            <button type="submit" className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white">
              Request updated costing
            </button>
          </div>
        </ActionForm>
      )}

      {open && open !== "REVISIONS_REQUESTED" && (
        <ActionForm
          action={recordProposalStatusAction.bind(null, proposalId)}
          className="mt-3 flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3"
        >
          <input type="hidden" name="toStatus" value={open} />
          <textarea
            name="note"
            rows={2}
            placeholder="Anything worth recording? (optional)"
            className="resize-none rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <ManagerConsent required={requiresManagerConsent} />
          <div>
            <button type="submit" className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white">
              Mark {STATUS_LABELS[open].toLowerCase()}
            </button>
          </div>
        </ActionForm>
      )}

      {events.length > 0 && (
        <ol className="mt-3 flex flex-col gap-1.5 border-t border-neutral-100 pt-3">
          {events.map((e) => (
            <li key={e.id} className="text-xs text-neutral-600">
              <span className="font-medium text-neutral-800">{STATUS_LABELS[e.toStatus]}</span>{" "}
              <span className="text-neutral-400">{new Date(e.at).toLocaleDateString()}</span>
              {e.byName && <span> · {e.byName}</span>}
              {/* Shown only when someone actually attested -- a manager's
                  own authority should not read like a rep's sign-off. */}
              {e.managerConsulted && <span className="text-neutral-400"> · manager consulted</span>}
              {e.note && <div className="text-neutral-500">{e.note}</div>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
