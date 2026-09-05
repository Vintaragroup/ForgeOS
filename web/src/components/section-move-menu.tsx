"use client";

import { useEffect, useRef, useState } from "react";

// Kebab-triggered popover for a flat/standalone (or untagged-booth)
// section's own "reparent to a different booth" tool -- same shell as
// BoothActionsMenu's own kebab (open on click, close on outside click/
// Escape/submit), just holding this section's single move form instead of
// a real booth's move-category/merge pair. Used to sit as a big,
// always-visible "Move all items to booth" button plus two raw text
// inputs right in the H1 header, crowding out Hide/Summarize/Exclude on
// every section whether or not anyone needed it that moment -- and unlike
// a real booth's header (Untag + a single "New group name" input), the
// extra width regularly forced those other buttons' own labels to wrap
// onto two or three lines, which is what actually made a standalone
// section's header look taller than a tagged booth's despite both using
// the exact same font-size/line-height.
export function SectionMoveMenu({ moveAction }: { moveAction: (formData: FormData) => void }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Move this section to a booth"
        title="Move this section to a booth"
        className={`flex h-6 w-6 items-center justify-center rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 hover:text-white ${open ? "bg-neutral-800 text-white" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="2.5" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13.5" r="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-1 rounded-md border border-neutral-700 bg-neutral-800 p-3 text-left normal-case shadow-xl">
          <form
            action={(formData) => {
              setOpen(false);
              moveAction(formData);
            }}
            className="flex flex-col gap-1"
          >
            <label htmlFor="section-move-booth" className="text-xs font-medium text-neutral-400">
              Move every item in this section to
            </label>
            <input
              id="section-move-booth"
              type="text"
              name="groupLabel"
              placeholder="Booth (blank = project-wide)"
              className="rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-400"
            />
            <input
              type="text"
              name="sectionName"
              placeholder="Group name"
              required
              className="rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-neutral-400"
            />
            <button
              type="submit"
              className="mt-1 rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 hover:text-white"
            >
              Move all items to booth
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
