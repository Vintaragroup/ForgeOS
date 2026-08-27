"use client";

// The only client-side polling in this feature -- bid-package-actions.ts's
// own comments describe the rest of this app's match-review UI as
// deliberately plain-forms-only. This is a real, intentional departure:
// proposeVendorQuoteItemsAction backgrounds the real extraction+match work
// via next/server's after(), which means the Server Action itself returns
// almost immediately -- there's no request left to block on, and no other
// push channel back to the browser once the response is sent. Polling
// getBidPackageExtractionStatusAction every couple seconds is the minimal
// way to surface that background work's real progress instead of leaving
// the page frozen on whatever it looked like at submit time.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBidPackageExtractionStatusAction } from "./bid-package-actions";

type Phase = "IDLE" | "READING_DOCUMENT" | "EXTRACTING_LINES" | "MATCHING" | "COMPLETE" | "FAILED";

const PHASE_LABELS: Record<Phase, string> = {
  IDLE: "Starting…",
  READING_DOCUMENT: "Reading document…",
  EXTRACTING_LINES: "Extracting priced line items via AI…",
  MATCHING: "Matching against your estimate…",
  COMPLETE: "Done.",
  FAILED: "Extraction failed.",
};

// Rough left-to-right position for the progress bar -- phase-level, not
// granular (see vendor-match-ai-service.ts's own header comment on why
// there's no real per-line progress to report). Purely a visual cue, not
// a measured percentage.
const PHASE_PROGRESS: Record<Phase, number> = {
  IDLE: 10,
  READING_DOCUMENT: 25,
  EXTRACTING_LINES: 60,
  MATCHING: 90,
  COMPLETE: 100,
  FAILED: 100,
};

const POLL_INTERVAL_MS = 2000;

export function VendorExtractionProgress({
  estimateId,
  bidPackageId,
  initialPhase,
  initialError,
}: {
  estimateId: string;
  bidPackageId: string;
  initialPhase: Phase;
  initialError: string | null;
}) {
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [error, setError] = useState<string | null>(initialError);
  const router = useRouter();
  // Guards against a poll landing after the component has already
  // stopped (terminal state reached, or unmounted) -- setState on an
  // unmounted/stale component is a no-op harm-wise, but the extra
  // in-flight request isn't.
  const stoppedRef = useRef(false);

  useEffect(() => {
    stoppedRef.current = false;
    const isTerminal = (p: Phase) => p === "COMPLETE" || p === "FAILED";
    if (isTerminal(phase)) return;

    const interval = setInterval(async () => {
      if (stoppedRef.current) return;
      const status = await getBidPackageExtractionStatusAction(estimateId, bidPackageId);
      if (stoppedRef.current) return;
      setPhase(status.phase);
      setError(status.error);
      if (isTerminal(status.phase)) {
        stoppedRef.current = true;
        clearInterval(interval);
        // Pulls the fresh page -- updated vendorQuoteLineItems and the
        // persisted matchResult -- so BidPackageCard swaps from this
        // progress view to the real match table (or the FAILED banner)
        // without a manual reload.
        router.refresh();
      }
    }, POLL_INTERVAL_MS);

    return () => {
      stoppedRef.current = true;
      clearInterval(interval);
    };
  }, [phase, estimateId, bidPackageId, router]);

  return (
    <div>
      <p className="mb-2 text-sm text-neutral-600">{PHASE_LABELS[phase]}</p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-100">
        <div
          className="h-full rounded-full bg-neutral-800 transition-all duration-500"
          style={{ width: `${PHASE_PROGRESS[phase]}%` }}
        />
      </div>
      {phase === "FAILED" && error && <p className="mt-2 text-xs text-red-700">{error}</p>}
    </div>
  );
}
