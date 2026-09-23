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
  REVISIONS_REQUESTED: "Change requested",
  // "Signed" described the paperwork; what people ask is whether the
  // client said yes. Same status, the word they actually use.
  SIGNED: "Approved by client",
  DECLINED: "Declined",
};

// The two answers a client actually comes back with, and the only two
// moves that get prominence once a proposal is out. Everything else on
// the panel is a secondary detail of those two.
const CLIENT_ANSWERS: ProposalStatus[] = ["SIGNED", "REVISIONS_REQUESTED"];

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
  const clientAnswers = CLIENT_ANSWERS.filter((s) => nextStatuses.includes(s));
  const otherStatuses = nextStatuses.filter((s) => !CLIENT_ANSWERS.includes(s));

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
        <div className="mt-3 flex flex-col gap-2">
          {/* Once it's out, the question is what the client said back.
              Those two answers lead, and the bookkeeping moves (still
              reviewing, declined) sit underneath in smaller type rather
              than competing with them. */}
          {clientAnswers.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {clientAnswers.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setOpen(open === s ? null : s)}
                  className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-neutral-50"
                >
                  {s === "SIGNED" ? "Client approved" : "Changes requested"}
                </button>
              ))}
            </div>
          )}
          {otherStatuses.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {otherStatuses.map((s) => (
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
        </div>
      )}

      {open === "REVISIONS_REQUESTED" && (
        <ActionForm
          action={requestProposalRevisionsAction.bind(null, proposalId)}
          className="mt-3 flex flex-col gap-2 rounded-md border border-amber-200 bg-amber-50 p-3"
          resetOnSuccess
          onSuccess={() => setOpen(null)}
        >
          <p className="text-xs text-amber-900">
            Records what the client asked for and opens the next version for re-costing. The sent version stays
            exactly as it is — it&apos;s the record of what they actually received.
            {" "}
            {/* The distinction that keeps the two words apart. */}
            This is not a change order: nothing has been ordered yet, so there is nothing to change. A change order
            is for scope a client adds after they&apos;ve signed.
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
              Request an estimate change
            </button>
          </div>
        </ActionForm>
      )}

      {/* The one move on this panel that cannot be undone from the UI: it
          advances the deal to WON and creates the Project. It asks who
          signed, which is both the record you want and the reason a
          stray click can't do it. */}
      {open === "SIGNED" && (
        <ActionForm
          action={recordProposalStatusAction.bind(null, proposalId)}
          className="mt-3 flex flex-col gap-2 rounded-md border border-green-200 bg-green-50 p-3"
          resetOnSuccess
          onSuccess={() => setOpen(null)}
        >
          <input type="hidden" name="toStatus" value="SIGNED" />
          <p className="text-xs text-green-900">
            Records the client&apos;s acceptance of this proposal, advances the deal to Won, and starts production.
          </p>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs text-neutral-700">
              <span>
                Signed by <span className="text-red-500">*</span>
              </span>
              <input
                name="signedByName"
                required
                placeholder="Who signed for the client"
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-700">
              <span>Title</span>
              <input
                name="signedByTitle"
                placeholder="Optional"
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs text-neutral-700">
              <span>When</span>
              <input
                type="date"
                name="at"
                max={new Date().toISOString().slice(0, 10)}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <ManagerConsent required={requiresManagerConsent} />
          <div>
            <button type="submit" className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white">
              Confirm client approval
            </button>
          </div>
        </ActionForm>
      )}

      {open && open !== "REVISIONS_REQUESTED" && open !== "SIGNED" && (
        <ActionForm
          action={recordProposalStatusAction.bind(null, proposalId)}
          className="mt-3 flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3"
          resetOnSuccess
          onSuccess={() => setOpen(null)}
        >
          <input type="hidden" name="toStatus" value={open} />
          <textarea
            name="note"
            rows={2}
            placeholder="Anything worth recording? (optional)"
            className="resize-none rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          {/* These get logged after the fact -- a proposal emailed on
              Tuesday, typed in on Friday. Blank means today, which is the
              common case, so this stays out of the way rather than
              demanding a date every time. */}
          <label className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
            <span>When did this happen?</span>
            <input
              type="date"
              name="at"
              max={new Date().toISOString().slice(0, 10)}
              className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
            />
            <span className="text-neutral-400">Leave blank for today.</span>
          </label>
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
