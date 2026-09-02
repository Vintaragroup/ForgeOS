"use client";

import { useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

export interface MethodFilterOption {
  id: string;
  label: string;
  count?: number;
}

// Secondary filter row nested inside one primary category tab (see
// PrimaryCategoryTabContent in the estimate page) -- structurally a sibling
// of Tabs (same URL-synced active-id pattern via router.replace, same
// lazy-mount-on-first-visit discipline, required here too since content is
// form-bearing CategoryTabContent JSX and Tabs' own header comment already
// explains both halves of why: switching away and back must never silently
// reset a form the user was mid-way through, but rendering every option's
// full content up front is a real, confirmed cost on a large estimate.
// Rendered as rounded pills rather than another bordered tablist so the
// two tab levels stay visually distinct at a glance, instead of reading as
// one flat row.
//
// URL-driven (not local useState) for the same reason Tabs itself is: this
// page's other forms (Untag, margin update, ...) all revalidatePath, which
// would silently reset a useState-backed filter back to "All" on any
// unrelated submit elsewhere on the page. `paramName` defaults to
// "categoryMethod" -- deliberately distinct from Tabs' own "tab"/"category"
// params already in use on this page.
export function CategoryMethodFilter({
  options,
  content,
  paramName = "categoryMethod",
}: {
  options: MethodFilterOption[];
  content: Record<string, ReactNode>;
  paramName?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const requested = searchParams.get(paramName);
  const activeId = options.some((o) => o.id === requested) ? requested! : options[0]?.id;

  // Same lazy-mount tracking as Tabs itself, adjusted during render for
  // the same reason -- see that component's own comment for the full
  // reasoning.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => new Set(activeId ? [activeId] : []));
  const [trackedActiveId, setTrackedActiveId] = useState(activeId);
  if (activeId !== trackedActiveId) {
    setTrackedActiveId(activeId);
    if (activeId && !visitedIds.has(activeId)) {
      setVisitedIds((prev) => new Set(prev).add(activeId));
    }
  }

  function selectOption(id: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramName, id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
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
