"use client";

import { useSyncExternalStore } from "react";

// This estimate's page is server-rendered, so a plain
// `entry.createdAt.toLocaleString()` call executes on the SERVER --
// Vercel's Node runtime defaults to UTC, not whichever timezone the
// person actually viewing the page is in, so an action taken at
// 10:22am Eastern rendered as "2:22 PM" (its UTC clock time) with no
// indication anything had been converted at all. Isolated into its own
// client component specifically so the conversion happens in the
// viewer's OWN browser, using whatever timezone their OS is actually
// set to (not a hardcoded company timezone, which would still be wrong
// for anyone outside it).
//
// useSyncExternalStore (not useState+useEffect) is what actually makes
// this hydration-safe: getServerSnapshot forces `false` for both the
// real server render and React's first client render (the one hydration
// diffs against), so the two agree and hydration never warns; only the
// EXTRA re-render React runs right after hydrating a leaf that used this
// hook picks up `true` and swaps in the real local time. There's nothing
// to subscribe to (this never changes again after mount), so `subscribe`
// is a no-op that never calls its listener.
function useHasMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function LocalTimestamp({
  iso,
  dateStyle = "medium",
  timeStyle = "short",
}: {
  iso: string | Date;
  dateStyle?: "full" | "long" | "medium" | "short";
  timeStyle?: "full" | "long" | "medium" | "short";
}) {
  const hasMounted = useHasMounted();
  if (!hasMounted) return <>—</>;
  return <>{new Date(iso).toLocaleString("en-US", { dateStyle, timeStyle })}</>;
}
