"use client";

import { Fragment, useState, type ReactNode } from "react";

// Shared accordion shell for the Line Items tab's H1 booth headers, H2
// element-group headers, and standalone/project-wide section headers --
// collapsed by default, so landing on a category tab shows a scannable
// list of section names and totals first, not every line item at once.
//
// Deliberately local useState, not a native <details>/<summary> -- every
// one of these headers already carries several bound-server-action
// buttons/forms (Hide from proposal, Untag, the booth kebab menu, +Group,
// per-item reorder, delete...) plus SectionHeadingEditor's own inline-edit
// controls. Put any of that inside a native <summary>, and clicking it
// BOTH fires its own action AND toggles the accordion on the same click,
// since a browser's disclosure-toggle and a button's own default action
// share the same click event -- calling preventDefault() to stop one
// stops the other too. A plain, separate toggle button sidesteps this
// entirely: it's the only thing that ever calls setOpen, so every other
// control in the header keeps behaving exactly as it did before.
//
// title and actions are rendered as the same two justify-between siblings
// the header row already used (title grouped with the toggle button on
// the left, actions unchanged on the right) -- this only inserts the
// toggle, it doesn't change the existing two-group layout.
//
// title/actions are each wrapped in their own keyed <Fragment> below --
// every caller builds them from JSX authored at the call site (page.tsx),
// so React never marks that JSX "validated" the way it does children
// created directly in this component's own return. Landing that
// unvalidated, unkeyed element straight into a 2-item children list here
// (paired with the chevron button, and with the header's other side) trips
// React's real list-reconciliation key check -- which, unlike its
// element-creation-time check, applies to any 2+-item children list
// regardless of whether it came from `.map()` or two fixed JSX children.
// A key on a freshly-created wrapper here (not on the caller's element)
// satisfies that check without pushing key management onto every caller.
export function CollapsibleGroup({
  title,
  actions,
  headerClassName,
  bodyClassName,
  chevronClassName,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  headerClassName: string;
  bodyClassName?: string;
  chevronClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className={headerClassName}>
        <div className="flex min-w-0 items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? "Collapse" : "Expand"}
            className={`flex shrink-0 items-center justify-center ${chevronClassName ?? "text-neutral-400 hover:text-white"}`}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              className={`transition-transform ${open ? "rotate-90" : ""}`}
              aria-hidden="true"
            >
              <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="sr-only">{open ? "Collapse" : "Expand"}</span>
          </button>
          <Fragment key="cg-title">{title}</Fragment>
        </div>
        <Fragment key="cg-actions">{actions}</Fragment>
      </div>
      {open && <div className={bodyClassName}>{children}</div>}
    </>
  );
}
