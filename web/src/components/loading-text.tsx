"use client";

import { useEffect, useState } from "react";

const DEFAULT_MESSAGES = ["Loading…"] as const;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

// A pending-state message that cross-fades between one or more strings
// instead of sitting static -- for a client component waiting on
// something with no real progress to report (unlike
// LineItemProposalProgress's batch-by-batch bar, which has actual numbers
// and should keep using those, not this). Pass a single message for a
// plain fade-in; pass several to cycle through them (e.g. reassuring the
// user during a long, silent wait: "Still working…", "Almost there…").
export function LoadingText({
  messages = DEFAULT_MESSAGES,
  intervalMs = 2600,
  fadeMs = 300,
  className = "text-sm text-neutral-500",
}: {
  messages?: readonly string[];
  intervalMs?: number;
  fadeMs?: number;
  className?: string;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const items = messages.length > 0 ? messages : DEFAULT_MESSAGES;

  useEffect(() => {
    if (reducedMotion || items.length <= 1) return;
    const interval = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIndex((current) => (current + 1) % items.length);
        setVisible(true);
      }, fadeMs);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [fadeMs, intervalMs, items.length, reducedMotion]);

  return (
    <p
      role="status"
      aria-live="polite"
      className={`transition-all duration-300 motion-reduce:transition-none ${
        visible ? "translate-y-0 opacity-100" : "translate-y-0.5 opacity-0"
      } ${className}`}
    >
      {items[index]}
    </p>
  );
}
