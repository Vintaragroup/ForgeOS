"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// The small outlined button + anchored panel that lets someone clear a
// DashRow from the row itself, without navigating away. The point is to
// work a queue top to bottom without losing your place, which a page
// transition per row defeats.
//
// Lives here rather than in one department's row-actions file: Sales and
// Graphics both use it, and a second copy would drift.

const BUTTON_CLASS =
  "rounded-md border border-[color:var(--dash-border)] px-2.5 py-1 text-xs font-medium text-[color:var(--dash-text-soft)] hover:border-[color:var(--dash-navy)] hover:text-[color:var(--dash-navy)]";

const PANEL_WIDTH = 256; // matches w-64 below
const GUTTER = 8;

export function Popover({ label, title, children }: { label: string; title: string; children: (close: () => void) => ReactNode }) {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const open = at !== null;
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Positioned fixed, measured off the trigger, rather than absolute
  // inside the row: .dash-card sets overflow:hidden to clip its rounded
  // corners, which would cut the panel off. Nothing in the dash CSS sets a
  // transform, so fixed really does escape to the viewport here.
  function toggle() {
    if (open) return setAt(null);
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAt({
      top: rect.bottom + 4,
      left: Math.max(GUTTER, Math.min(rect.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - GUTTER)),
    });
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setAt(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAt(null);
    };
    // Closed rather than repositioned on scroll: the panel is anchored to a
    // row in a long list, and chasing it while the page moves is worse than
    // dismissing it.
    const onScroll = () => setAt(null);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  return (
    <div ref={ref}>
      <button ref={buttonRef} type="button" onClick={toggle} className={BUTTON_CLASS} aria-expanded={open}>
        {label}
      </button>
      {at && (
        <div
          style={{ top: at.top, left: at.left, width: PANEL_WIDTH }}
          className="fixed z-50 rounded-lg border border-neutral-200 bg-white p-3 text-left shadow-xl"
        >
          <p className="mb-2 text-xs font-semibold text-neutral-900">{title}</p>
          {children(() => setAt(null))}
        </div>
      )}
    </div>
  );
}


export { BUTTON_CLASS as ROW_BUTTON_CLASS };
