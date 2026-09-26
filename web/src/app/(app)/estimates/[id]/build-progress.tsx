"use client";

// Live progress for "Build from all analyzed documents".
//
// Same shape as line-item-proposal-progress.tsx, which is the precedent
// in this codebase: the action hands the real work to after() and returns
// immediately, so there is no request left to block on and no push
// channel back to the browser. Polling is the minimal way to show what
// the run is actually doing.
//
// Worth it here more than anywhere else in the app. A real build on The
// Pharmacy Hub took ten minutes across six documents and two drawings,
// and every second of it looked identical on screen -- a static
// "Building...", then a bare "Something went wrong" when the platform
// killed the function.

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getBuildProgressAction } from "./import-actions";

const POLL_INTERVAL_MS = 2500;

export function BuildProgress({
  estimateId,
  versionId,
  initialRunning,
  initialStepIndex,
  initialStepTotal,
  initialCurrentFile,
}: {
  estimateId: string;
  versionId: string;
  initialRunning: boolean;
  initialStepIndex: number | null;
  initialStepTotal: number | null;
  initialCurrentFile: string | null;
}) {
  const [running, setRunning] = useState(initialRunning);
  const [stepIndex, setStepIndex] = useState(initialStepIndex);
  const [stepTotal, setStepTotal] = useState(initialStepTotal);
  const [currentFile, setCurrentFile] = useState(initialCurrentFile);
  const router = useRouter();
  // Guards a poll that lands after this component has stopped or
  // unmounted -- the same hazard line-item-proposal-progress.tsx handles.
  const stopped = useRef(false);

  useEffect(() => {
    if (!running) return;
    stopped.current = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const status = await getBuildProgressAction(estimateId, versionId);
        if (stopped.current) return;
        setStepIndex(status.stepIndex);
        setStepTotal(status.stepTotal);
        setCurrentFile(status.currentFile);
        if (!status.running) {
          setRunning(false);
          stopped.current = true;
          // Pull the finished run's own report -- what was imported, what
          // was skipped, and why it stopped if it did.
          router.refresh();
          return;
        }
      } catch {
        // A failed poll is not worth surfacing: the run writes its own
        // outcome to the version either way, and the next poll or the
        // refresh on completion will pick it up.
      }
      if (!stopped.current) timer = setTimeout(poll, POLL_INTERVAL_MS);
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      stopped.current = true;
      clearTimeout(timer);
    };
  }, [running, estimateId, versionId, router]);

  if (!running) return null;

  const pct = stepIndex != null && stepTotal ? Math.round((stepIndex / stepTotal) * 100) : null;

  return (
    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm" role="status" aria-live="polite">
      <p className="font-medium text-blue-900">
        Building…
        {stepIndex != null && stepTotal ? ` document ${stepIndex} of ${stepTotal}` : ""}
      </p>
      {currentFile && <p className="truncate text-blue-800">{currentFile}</p>}
      {pct !== null && (
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-blue-100">
          <div className="h-full rounded-full bg-blue-500 transition-all duration-500" style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="mt-1.5 text-xs text-blue-700">
        Drawings are read page by page and take about a minute each. You can leave this page — the run carries on and
        stops itself after eight minutes if there is more to do.
      </p>
    </div>
  );
}
