"use client";

import { useDismissableMenu } from "@/lib/use-dismissable-menu";

// Kebab-triggered popover for a flat/standalone (or untagged-booth)
// section's own H1-level tools -- same shell as BoothActionsMenu's own
// kebab (open on click, close on outside click/Escape/submit), holding
// this section's "reparent to a different booth" move form plus, when a
// merge target exists, a "merge this whole group into a different H2"
// form -- the identical move+merge pairing BoothActionsMenu already
// bundles for a real tagged booth's H1. Used to sit as a big, always-
// visible "Move all items to booth" button plus two raw text inputs right
// in the H1 header, crowding out Hide/Summarize/Exclude on every section
// whether or not anyone needed it that moment -- and unlike a real
// booth's header (Untag + a single "New group name" input), the extra
// width regularly forced those other buttons' own labels to wrap onto two
// or three lines, which is what actually made a standalone section's
// header look taller than a tagged booth's despite both using the exact
// same font-size/line-height.
//
// mergeAction/targetGroupOptions used to be their own separate kebab
// (ElementGroupActionsMenu, dark theme) rendered right next to this one --
// confirmed live as a real duplicate-kebab bug: a standalone section's H1
// showed TWO identical-looking "..." buttons side by side, one for move
// and one for merge, where a real tagged booth's H1 only ever shows ONE
// (BoothActionsMenu already bundles its own move+merge pair the same
// way). Folded the merge form in here instead, matching that same one-
// kebab-per-H1 convention -- ElementGroupActionsMenu itself is unchanged
// and still used on its own for a real H2 group's own (move-less) merge
// tool.
export function SectionMoveMenu({
  moveAction,
  mergeAction,
  targetGroupOptions = [],
}: {
  moveAction: (formData: FormData) => void;
  mergeAction?: ((formData: FormData) => void) | null;
  targetGroupOptions?: { value: string; label: string }[];
}) {
  const { open, setOpen, containerRef } = useDismissableMenu();

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Move or merge this section"
        title="Move or merge this section"
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
          {mergeAction && targetGroupOptions.length > 0 && (
            <form
              action={(formData) => {
                setOpen(false);
                mergeAction(formData);
              }}
              className="flex flex-col gap-1 border-t border-neutral-700 pt-3"
            >
              <label htmlFor="section-merge-target" className="text-xs font-medium text-neutral-400">
                Merge this entire group into
              </label>
              <select
                id="section-merge-target"
                name="targetSectionId"
                className="rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-400"
              >
                {targetGroupOptions.map((opt) => (
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
