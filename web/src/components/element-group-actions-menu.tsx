"use client";

import { useEffect, useRef, useState } from "react";

// H2-level counterpart to BoothActionsMenu's own H1-level merge tool --
// same kebab-triggered popover pattern (open on click, close on outside
// click/Escape/submit), light-themed to match this H2 header's own
// bg-neutral-100 bar instead of a real booth's dark H1 one. Only ever
// carries the merge form (unlike BoothActionsMenu, which also has a
// move-to-category form) -- an H2 has no analogous "move this whole group
// to a different category" concept of its own; individual items already
// move category via their own edit form or MoveSelectedItemsBar.
export function ElementGroupActionsMenu({
  mergeAction,
  targetGroupOptions,
  theme = "light",
}: {
  mergeAction: (formData: FormData) => void;
  targetGroupOptions: { value: string; label: string }[];
  // "dark" for a standalone/flat section, which renders with the same H1
  // header treatment as a real booth (see orderedFlatSectionGroups' own
  // comment in this file) -- its own merge tool needs to match that dark
  // bar instead of this component's default light H2 styling.
  theme?: "light" | "dark";
}) {
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

  if (targetGroupOptions.length === 0) return null;
  const dark = theme === "dark";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Merge this group"
        title="Merge this group into another"
        className={
          dark
            ? `flex h-6 w-6 items-center justify-center rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 hover:text-white ${open ? "bg-neutral-800 text-white" : ""}`
            : `flex h-6 w-6 items-center justify-center rounded border border-neutral-300 text-neutral-500 hover:bg-white hover:text-neutral-900 ${open ? "bg-white text-neutral-900" : ""}`
        }
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="2.5" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13.5" r="1.5" />
        </svg>
      </button>
      {open && (
        <div
          className={
            dark
              ? "absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-1 rounded-md border border-neutral-700 bg-neutral-800 p-3 text-left normal-case shadow-xl"
              : "absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-1 rounded-md border border-neutral-300 bg-white p-3 text-left normal-case shadow-xl"
          }
        >
          <form
            action={(formData) => {
              setOpen(false);
              mergeAction(formData);
            }}
            className="flex flex-col gap-1"
          >
            <label
              htmlFor="element-group-merge-target"
              className={`text-xs font-medium ${dark ? "text-neutral-400" : "text-neutral-500"}`}
            >
              Merge this entire group into
            </label>
            <select
              id="element-group-merge-target"
              name="targetSectionId"
              className={
                dark
                  ? "rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-400"
                  : "rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 outline-none focus:border-neutral-500"
              }
            >
              {targetGroupOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className={
                dark
                  ? "mt-1 rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 hover:text-white"
                  : "mt-1 rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
              }
            >
              Merge into
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
