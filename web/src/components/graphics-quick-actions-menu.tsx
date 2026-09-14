"use client";

import Link from "next/link";
import { useDismissableMenu } from "@/lib/use-dismissable-menu";

// The Graphics dashboard's kebab -- everything that isn't frequent enough
// to earn its own big action button (see the dashboard's own "+ Client" /
// "+ Create Order" buttons), but still needs to live somewhere on the page.
// Same open/outside-click/Escape-close popover pattern as
// ElementGroupActionsMenu (booth-actions-menu.tsx's own sibling), just with
// two independent sections instead of one merge form.
export function GraphicsQuickActionsMenu({
  linkOpportunityAction,
  showOptions,
  opportunityOptions,
  defaultShowId,
  exportHref,
}: {
  linkOpportunityAction: (formData: FormData) => void;
  showOptions: { value: string; label: string }[];
  opportunityOptions: { value: string; label: string }[];
  defaultShowId: string;
  exportHref: string;
}) {
  const { open, setOpen, containerRef } = useDismissableMenu();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
        className={`flex h-11 w-11 items-center justify-center rounded-lg border border-neutral-300 text-neutral-600 hover:bg-neutral-50 ${open ? "bg-neutral-50" : ""}`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="2.5" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13.5" r="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-80 rounded-md border border-neutral-300 bg-white p-4 text-left shadow-xl">
          <Link
            href={exportHref}
            onClick={() => setOpen(false)}
            className="mb-4 block rounded-md border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Export production log (CSV) →
          </Link>

          {opportunityOptions.length === 0 || showOptions.length === 0 ? (
            <p className="text-xs text-neutral-400">
              {showOptions.length === 0
                ? "No shows exist yet to link an opportunity to."
                : "No unassigned opportunity is available to link to a show."}
            </p>
          ) : (
            <form
              action={(formData) => {
                setOpen(false);
                linkOpportunityAction(formData);
              }}
              className="flex flex-col gap-2"
            >
              <span className="text-xs font-medium text-neutral-500">Link opportunity to show</span>
              <select
                name="showId"
                defaultValue={defaultShowId}
                className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-700 outline-none focus:border-neutral-500"
              >
                {showOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <select
                name="opportunityId"
                defaultValue=""
                className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm text-neutral-700 outline-none focus:border-neutral-500"
              >
                {opportunityOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="mt-1 rounded border border-neutral-300 px-2 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100"
              >
                Link
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
