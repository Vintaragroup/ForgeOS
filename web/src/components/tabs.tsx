"use client";

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
// which one is visible, via `display:none` on the rest (kept mounted,
// not unmounted, so a form the user was mid-way through in another tab
// isn't silently reset by switching away and back).
//
// Active tab syncs to a URL search param (default "tab") via
// router.replace -- shallow, no server round-trip, no scroll reset --
// so a tab is always a real bookmarkable/shareable URL, not just
// in-memory state that a page refresh would forget.
export function Tabs({
  tabs,
  content,
  paramName = "tab",
  beforeContent,
}: {
  tabs: TabDef[];
  content: Record<string, ReactNode>;
  paramName?: string;
  // Rendered once, between the tab strip and whichever tab's content is
  // showing -- for a control that applies the same way regardless of
  // which tab is active (e.g. "add a new section"), so it doesn't need
  // duplicating into every tab's own content.
  beforeContent?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const requested = searchParams.get(paramName);
  const activeId = tabs.some((t) => t.id === requested) ? requested! : tabs[0]?.id;

  function selectTab(id: string) {
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
          {content[tab.id]}
        </div>
      ))}
    </div>
  );
}
