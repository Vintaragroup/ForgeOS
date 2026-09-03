"use client";

import { useEffect, useRef, useState } from "react";

// Move-booth and merge-booth used to sit as two always-visible forms right
// in the booth's H1 header, competing for space with Hide/Untag/reorder on
// every booth whether or not anyone needed them. Tucked behind this
// kebab-triggered popover instead -- opens on click, closes on an outside
// click, an Escape press, or picking either action (the ensuing
// revalidatePath re-render remounts the header anyway, but closing
// immediately avoids a stale open panel flashing over new content).
export function BoothActionsMenu({
  moveAction,
  categoryOptions,
  currentCategory,
  mergeAction,
  targetBoothOptions,
}: {
  moveAction: (formData: FormData) => void;
  categoryOptions: { value: string; label: string }[];
  // This booth's category in the tab this menu instance is rendered from
  // -- excluded from the "move to" list below (moving a booth "to" the
  // category it's already showing in is meaningless), and named in the
  // label instead, so the select never opens pre-showing an unrelated
  // category as if it meant something (confirmed live: with no current-
  // category exclusion, the select just defaults to the browser's own
  // first <option>, i.e. whichever category sorts first -- misleading
  // regardless of what that happens to be, and a real reported bug when
  // it happened to coincide with the category the user was about to pick
  // anyway, reading as "already selected" and "doesn't move").
  currentCategory: string;
  mergeAction: ((formData: FormData) => void) | null;
  targetBoothOptions: { value: string; label: string }[];
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

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Move or merge this booth"
        title="Move or merge this booth"
        className={`flex h-6 w-6 items-center justify-center rounded border border-neutral-600 text-neutral-300 hover:bg-neutral-800 hover:text-white ${open ? "bg-neutral-800 text-white" : ""}`}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="8" cy="2.5" r="1.5" />
          <circle cx="8" cy="8" r="1.5" />
          <circle cx="8" cy="13.5" r="1.5" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 flex w-64 flex-col gap-3 rounded-md border border-neutral-700 bg-neutral-800 p-3 text-left normal-case shadow-xl">
          <form
            action={(formData) => {
              setOpen(false);
              moveAction(formData);
            }}
            className="flex flex-col gap-1"
          >
            <label htmlFor="booth-move-category" className="text-xs font-medium text-neutral-400">
              Move every item out of {currentCategory} to
            </label>
            <select
              id="booth-move-category"
              name="category"
              className="rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-400"
            >
              {categoryOptions
                .filter((opt) => opt.value !== currentCategory)
                .map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
            </select>
            <button
              type="submit"
              className="mt-1 rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 hover:text-white"
            >
              Move booth
            </button>
          </form>
          {mergeAction && targetBoothOptions.length > 0 && (
            <form
              action={(formData) => {
                setOpen(false);
                mergeAction(formData);
              }}
              className="flex flex-col gap-1 border-t border-neutral-700 pt-3"
            >
              <label htmlFor="booth-merge-target" className="text-xs font-medium text-neutral-400">
                Merge this entire booth into
              </label>
              <select
                id="booth-merge-target"
                name="targetGroupLabel"
                className="rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-400"
              >
                {targetBoothOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="mt-1 rounded border border-neutral-600 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 hover:text-white"
              >
                Merge into
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
