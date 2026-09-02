"use client";

import { useState } from "react";
import type { ReactNode } from "react";

export interface MethodFilterOption {
  id: string;
  label: string;
  count?: number;
}

// Secondary filter row nested inside one primary category tab (see
// PrimaryCategoryTabContent in the estimate page) -- structurally a sibling
// of Tabs (same lazy-mount-on-first-visit discipline, required here too
// since content is form-bearing CategoryTabContent JSX: switching away and
// back must never silently reset a form the user was mid-way through, but
// rendering every option's full content up front is a real, confirmed cost
// on a large estimate. Rendered as rounded pills rather than another
// bordered tablist so the two tab levels stay visually distinct at a
// glance, instead of reading as one flat row.
//
// Plain useState, deliberately NOT synced to a URL search param (unlike
// Tabs itself, which stays URL-synced because Server Action redirects
// depend on it -- see that component's own comment). Nothing deep-links
// to a specific method filter, and this page's own `page.tsx` reads
// `searchParams` at all, which makes Next.js treat every query-string
// change as needing a brand-new full server render -- confirmed live as
// several real seconds of delay per click on a large estimate, for a
// value nothing outside this component ever needed in the URL. No
// external source of truth to reconcile means no render-time adjustment
// trick is needed either -- selectOption just sets both pieces of state
// together like a normal event handler.
export function CategoryMethodFilter({
  options,
  content,
}: {
  options: MethodFilterOption[];
  content: Record<string, ReactNode>;
}) {
  const [activeId, setActiveId] = useState(options[0]?.id);
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => new Set(activeId ? [activeId] : []));

  function selectOption(id: string) {
    setActiveId(id);
    setVisitedIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isActive = option.id === activeId;
          const isEmpty = option.count === 0;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => selectOption(option.id)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                isActive
                  ? "border-brand-navy bg-brand-navy text-white"
                  : isEmpty
                    ? "border-neutral-200 text-neutral-400 hover:border-neutral-300 hover:text-neutral-600"
                    : "border-neutral-300 text-neutral-600 hover:border-neutral-400 hover:text-neutral-900"
              }`}
            >
              {option.label}
              {typeof option.count === "number" && option.count > 0 && (
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                    isActive ? "bg-white/20 text-white" : "bg-neutral-100 text-neutral-500"
                  }`}
                >
                  {option.count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {options.map((option) => (
        <div key={option.id} hidden={option.id !== activeId}>
          {visitedIds.has(option.id) ? content[option.id] : null}
        </div>
      ))}
    </div>
  );
}
