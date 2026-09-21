"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ActionForm } from "@/components/action-form";
import { SNOOZE_PRESETS, TOUCH_MODES, type SalesQueueKey } from "@/lib/sales-queue";
import { confirmActivityAction, logTouchAction, snoozeAction } from "@/app/(app)/sales/actions";

// The buttons that let a rep clear a queue row from the row itself.
//
// Each opens a small popover anchored to the row rather than navigating:
// the point is to work a queue top to bottom without losing your place,
// which a page transition per client defeats. Only one popover is open at
// a time, and Escape or a click outside closes it.
//
// These render inside a DashRow's `actions` slot. That slot is only ever
// used on rows without an href -- a button inside a <Link> would fight the
// navigation -- so the four queues on /sales can use these and the linked
// client rows can't.

const BUTTON_CLASS =
  "rounded-md border border-[color:var(--dash-border)] px-2.5 py-1 text-xs font-medium text-[color:var(--dash-text-soft)] hover:border-[color:var(--dash-navy)] hover:text-[color:var(--dash-navy)]";

const PANEL_WIDTH = 256; // matches w-64 below
const GUTTER = 8;

function Popover({ label, title, children }: { label: string; title: string; children: (close: () => void) => ReactNode }) {
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

export function LogTouchButton({ companyId, companyName }: { companyId: string; companyName: string }) {
  return (
    <Popover label="Log touch" title={`Log contact with ${companyName}`}>
      {(close) => (
        <ActionForm action={logTouchAction} className="flex flex-col gap-2" resetOnSuccess>
          <input type="hidden" name="companyId" value={companyId} />
          <select name="mode" className="rounded-md border border-neutral-300 px-2 py-1.5 text-sm" defaultValue="Call">
            {TOUCH_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <textarea
            name="note"
            rows={2}
            placeholder="What was said? (optional)"
            className="resize-none rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
          />
          <button type="submit" onClick={() => setTimeout(close, 0)} className="rounded-md bg-brand-black px-3 py-1.5 text-sm font-medium text-white">
            Log it
          </button>
        </ActionForm>
      )}
    </Popover>
  );
}

export function SnoozeButton({ queue, targetKey }: { queue: SalesQueueKey; targetKey: string }) {
  return (
    <Popover label="Snooze" title="Hide this until">
      {(close) => (
        <ActionForm action={snoozeAction} className="flex flex-col gap-2">
          <input type="hidden" name="queue" value={queue} />
          <input type="hidden" name="targetKey" value={targetKey} />
          <div className="grid grid-cols-2 gap-1.5">
            {SNOOZE_PRESETS.map((p) => (
              <button
                key={p.days}
                type="submit"
                name="days"
                value={p.days}
                onClick={() => setTimeout(close, 0)}
                className="rounded-md border border-neutral-300 px-2 py-1.5 text-xs font-medium text-neutral-700 hover:border-neutral-500"
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="text-[11px] leading-snug text-neutral-500">Only hidden for you. It comes back on its own.</p>
        </ActionForm>
      )}
    </Popover>
  );
}

export function ConfirmActivityButton({ salesmateId }: { salesmateId: string }) {
  return (
    <ActionForm action={confirmActivityAction}>
      <input type="hidden" name="salesmateId" value={salesmateId} />
      <button type="submit" className={BUTTON_CLASS} title="Mark this as done and record it as contact">
        It happened
      </button>
    </ActionForm>
  );
}
