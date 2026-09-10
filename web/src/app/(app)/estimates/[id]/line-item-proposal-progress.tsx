"use client";

// The only other client-side polling precedent in this codebase is
// vendor-extraction-progress.tsx (bid-package-actions.ts's own comment
// explains why that one exists) -- same shape here: proposeScopeItemsAction's
// DRAWING branch (import-actions.ts) backgrounds the real batched
// extraction work via next/server's after(), so the Server Action itself
// returns almost immediately and there's no request left to block on, and
// no other push channel back to the browser once the response is sent.
// Polling getDocumentLineItemProposalStatusAction every couple seconds is
// the minimal way to surface that background work's real batch-by-batch
// progress instead of leaving the page frozen on whatever it looked like
// at submit time.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getDocumentLineItemProposalStatusAction } from "./import-actions";

type Status = "IDLE" | "ANALYZING" | "COMPLETE" | "FAILED";

const POLL_INTERVAL_MS = 2000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(Math.round(ms / 1000), 0);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  return `${Math.round(totalSeconds / 60)}m`;
}

export function LineItemProposalProgress({
  estimateId,
  documentId,
  initialStatus,
  initialBatchIndex,
  initialBatchTotal,
  initialStartedAt,
  initialError,
}: {
  estimateId: string;
  documentId: string;
  initialStatus: Status;
  initialBatchIndex: number | null;
  initialBatchTotal: number | null;
  // ISO string -- fixed for the life of one run (proposeLineItemsFromDrawing
  // only ever writes this once, at the very start), never re-fetched on
  // each poll, just used as the anchor for the elapsed-time calculation
  // below.
  initialStartedAt: string;
  initialError: string | null;
}) {
  const [status, setStatus] = useState<Status>(initialStatus);
  const [batchIndex, setBatchIndex] = useState(initialBatchIndex);
  const [batchTotal, setBatchTotal] = useState(initialBatchTotal);
  const [error, setError] = useState<string | null>(initialError);
  // Date.now() can't be called directly during render (react-hooks/purity)
  // -- tracked as state instead, ticked on its own independent interval so
  // the remaining-time estimate below stays live between polls too.
  const [now, setNow] = useState<number | null>(null);
  const router = useRouter();
  // Guards against a poll landing after this component has already
  // stopped (terminal state reached, or unmounted) -- setState on an
  // unmounted/stale component is a no-op harm-wise, but the extra
  // in-flight request isn't.
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (status === "COMPLETE" || status === "FAILED") return;
    // Ticks setNow from inside the interval callback only, never
    // synchronously in the effect body itself -- the remaining-time
    // estimate below simply withholds its label (same as the
    // zero-completed-batches case) for the first second, rather than
    // forcing an immediate setState here.
    const ticker = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ticker);
  }, [status]);

  useEffect(() => {
    stoppedRef.current = false;
    const isTerminal = (s: Status) => s === "COMPLETE" || s === "FAILED";
    if (isTerminal(status)) return;

    const interval = setInterval(async () => {
      if (stoppedRef.current) return;
      const result = await getDocumentLineItemProposalStatusAction(estimateId, documentId);
      if (stoppedRef.current) return;
      setStatus(result.status);
      setBatchIndex(result.batchIndex);
      setBatchTotal(result.batchTotal);
      setError(result.error);
      if (isTerminal(result.status)) {
        stoppedRef.current = true;
        clearInterval(interval);
        // Pulls the fresh page -- the final proposedLineItems/Gaps write,
        // or the FAILED banner -- so the Propose card swaps out of this
        // progress view without a manual reload.
        router.refresh();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      stoppedRef.current = true;
      clearInterval(interval);
    };
  }, [status, estimateId, documentId, router]);

  // batchIndex is the number of batches ALREADY COMPLETE at any poll --
  // proposeLineItemsFromDrawing writes it to 0 before batch 1 starts, then
  // bumps it to i immediately after batch i finishes and before batch i+1
  // starts (see that function's own loop). So batchIndex doubles as both
  // "batches done so far" and "which batch is currently running" (+1).
  const batchesDone = batchIndex ?? 0;
  const startedAtMs = new Date(initialStartedAt).getTime();
  // Adaptive, calibrated to THIS run's own observed latency so far (real
  // network/document conditions), not a fixed guess -- same "don't invent
  // a number" posture as this feature's other timing constants. Withheld
  // until at least one batch has actually finished -- an estimate from
  // zero samples would be worse than showing nothing.
  const remainingLabel =
    now !== null && batchTotal && batchesDone > 0 && batchesDone < batchTotal
      ? formatDuration(((now - startedAtMs) / batchesDone) * (batchTotal - batchesDone))
      : null;

  const label =
    batchTotal && batchIndex !== null
      ? `Analyzing batch ${Math.min(batchIndex + 1, batchTotal)} of ${batchTotal}…`
      : "Starting analysis…";

  const progressPercent = batchTotal ? Math.round((batchesDone / batchTotal) * 100) : 5;

  return (
    <div>
      <p className="mb-2 text-sm text-neutral-600">
        {label}
        {remainingLabel && <span className="text-neutral-400"> (~{remainingLabel} remaining)</span>}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-neutral-800 transition-all duration-500"
          style={{ width: `${Math.max(progressPercent, 5)}%` }}
        />
      </div>
      {status === "FAILED" && error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
