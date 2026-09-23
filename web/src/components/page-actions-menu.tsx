"use client";

import type { ReactNode } from "react";
import { useDismissableMenu } from "@/lib/use-dismissable-menu";

// The kebab a page header hangs its rare and destructive actions off.
//
// Delete opportunity and Archive estimate used to sit in the open, solid
// red, as the single heaviest element on their page -- Delete with nothing
// beside it but "Intake & review", a routine workflow step one pixel away
// from destroying the record. Visual weight should track how often an
// action is wanted, and destroying a deal is the rarest thing anyone does
// here.
//
// Same open/outside-click/Escape behaviour as the three existing kebabs
// (booth-actions-menu, element-group-actions-menu, section-move-menu) via
// the shared useDismissableMenu, but generic: it takes children rather
// than one use-case's own props, because "the header's overflow actions"
// is not a shape worth re-describing per page.
export function PageActionsMenu({
  label = "More actions",
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  const { open, setOpen, containerRef } = useDismissableMenu();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={`flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-300 text-neutral-600 hover:bg-neutral-50 ${
          open ? "bg-neutral-50" : ""
        }`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="2.5" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13.5" r="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-64 rounded-md border border-neutral-300 bg-white p-2 text-left shadow-xl">
          {children}
        </div>
      )}
    </div>
  );
}
