"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  // Shown next to the label when > 0; omitted entirely (not "0") so an
  // empty tab reads as genuinely empty rather than "0 of something,"
  // matching how a blank Excel sheet tab carries no count at all.
  count?: number;
}

// Generic, content-agnostic tab bar: every tab's content is already
// server-rendered JSX (a normal Server Component page renders this and
// hands it fully-formed `tabs[].content`) -- this component only owns
// which one is visible, via `display:none` on the rest (kept mounted
// once visited, not unmounted again, so a form the user was mid-way
// through in another tab isn't silently reset by switching away and
// back). A tab NOT yet visited this session isn't rendered at all until
// its first click -- confirmed live as a real, severe cost on a large
// real estimate (300+ line items across 9 category tabs): rendering
// every tab's full content up front, even ones nobody looks at this
// session, meant the browser held all of that DOM in memory
// simultaneously, making even a "free" client-side tab switch visibly
// slow. Lazy-mounting fixes the common case (most sessions never visit
// every tab) without giving up the state-preservation the original
// mount-everything approach existed for, for whichever tabs actually
// get visited.
//
// Active tab syncs to a URL search param (default "tab") via
// router.replace -- shallow, no scroll reset -- so a tab is always a
// real bookmarkable/shareable URL, not just in-memory state that a page
// refresh would forget. This is load-bearing, not just a nicety: several
// Server Actions (import-actions.ts's redirects after building/
// reconciling/enriching a document, the bid-package "Apply" redirect in
// this same page) redirect straight to `?tab=documents` /
// `?tab=review` / `?tab=bid-packages` so a result banner shows up on the
// right tab. Set urlSync=false for a tab bar nothing ever deep-links
// to (see the category tabs and CategoryMethodFilter on the estimate
// page) -- confirmed live that page.tsx reading `searchParams` at all
// makes EVERY query-string change fully dynamic, so router.replace here
// was forcing a brand-new full server render (refetch + rebuild every
// tab's content, not just the one being switched to) on every single
// tab click, several real seconds on a large estimate. urlSync=false
// skips useSearchParams/router.replace for that instance entirely, so a
// click never leaves the browser.
export function Tabs({
  tabs,
  content,
  paramName = "tab",
  beforeContent,
  urlSync = true,
}: {
  tabs: TabDef[];
  content: Record<string, ReactNode>;
  paramName?: string;
  // Rendered once, between the tab strip and whichever tab's content is
  // showing -- for a control that applies the same way regardless of
  // which tab is active (e.g. "add a new section"), so it doesn't need
  // duplicating into every tab's own content.
  beforeContent?: ReactNode;
  urlSync?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const requested = searchParams.get(paramName);
  const urlActiveId = tabs.some((t) => t.id === requested) ? requested! : tabs[0]?.id;

  // Internal source of truth when urlSync is false; its initial value
  // still honors a pre-existing valid `?<paramName>=` (an old bookmark,
  // say) but nothing writes back to the URL afterward.
  const [localActiveId, setLocalActiveId] = useState(urlActiveId);
  const activeId = urlSync ? urlActiveId : localActiveId;

  // Seeded with whichever tab is active on first render (the lazy
  // initializer runs before the first paint, so that one tab's content
  // is never delayed by a frame) -- every other tab joins this set only
  // once actually selected, client-side navigation (back/forward,
  // pasting a ?tab= link) included, not just a direct click below.
  // "Adjusting state during render" (React's own recommended pattern for
  // this, not a useEffect) -- activeId can change without this component
  // re-mounting (router.replace, or plain setLocalActiveId below), so
  // the update has to converge in the SAME render that first sees the
  // new activeId, not one render later.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => new Set(activeId ? [activeId] : []));
  const [trackedActiveId, setTrackedActiveId] = useState(activeId);
  if (activeId !== trackedActiveId) {
    setTrackedActiveId(activeId);
    if (activeId && !visitedIds.has(activeId)) {
      setVisitedIds((prev) => new Set(prev).add(activeId));
    }
  }

  function selectTab(id: string) {
    if (!urlSync) {
      setLocalActiveId(id);
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div role="tablist" className="mb-6 flex flex-wrap gap-1 border-b border-neutral-200">
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          // Muted, not hidden, for a tab with nothing in it yet -- see
          // Tabs' own header comment on why every category always shows
          // as a tab (matches how an Excel sheet tab exists whether or
          // not it has data), just visually de-emphasized so it doesn't
          // compete for attention with tabs that have real content.
          const isEmpty = tab.count === 0;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => selectTab(tab.id)}
              className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "border-brand-navy text-neutral-900"
                  : isEmpty
                    ? "border-transparent text-neutral-400 hover:text-neutral-600"
                    : "border-transparent text-neutral-500 hover:text-neutral-900"
              }`}
            >
              {tab.label}
              {typeof tab.count === "number" && tab.count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-xs ${
                    isActive ? "bg-brand-teal-pale text-brand-navy" : "bg-neutral-100 text-neutral-500"
                  }`}
                >
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {beforeContent}
      {tabs.map((tab) => (
        <div key={tab.id} hidden={tab.id !== activeId}>
          {visitedIds.has(tab.id) ? content[tab.id] : null}
        </div>
      ))}
    </div>
  );
}
