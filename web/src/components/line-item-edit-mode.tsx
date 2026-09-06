"use client";

import { createContext, useContext, useMemo, useState, useTransition } from "react";

// Tenth client component (see create-bid-package-bar.tsx's header
// comment on the ninth). Default context value is null, not a real
// provider -- same convention as bid-package-selection.tsx -- so
// LineItemRow calls useLineItemEditMode() unconditionally and treats a
// null context as "no section edit mode active," rendering its normal
// read-only row whether or not a LineItemsTable wraps it in a
// LineItemEditModeProvider (never done for a locked version's table --
// see LineItemsTable's own comment).
//
// Exists for the estimator feedback: "Rather than clicking Edit on every
// line item, it would be much faster if an expanded section could be
// placed into Edit Mode and changed directly in the visible
// grid -- Type, Description, Quantity, etc. -- then turned off when
// finished." One Save commits every changed row in the table at once via
// bulkUpdateLineItemsAction, instead of the existing per-row
// open/edit/save cycle (LineItemRow's own isEditing state and pencil
// icon, unchanged and still what renders whenever this isn't active).
const LineItemEditModeContext = createContext<{ isActive: boolean } | null>(null);

export function useLineItemEditMode() {
  return useContext(LineItemEditModeContext);
}

export function LineItemEditModeProvider({
  bulkUpdateAction,
  children,
}: {
  bulkUpdateAction: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
}) {
  const [isActive, setIsActive] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const value = useMemo(() => ({ isActive }), [isActive]);

  function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formData = new FormData(e.currentTarget);
    startTransition(async () => {
      try {
        await bulkUpdateAction(formData);
        setIsActive(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't save these changes.");
      }
    });
  }

  return (
    <LineItemEditModeContext.Provider value={value}>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        {isActive ? (
          <span className="text-xs text-neutral-500">Edit mode — change fields below, then Save.</span>
        ) : (
          <span />
        )}
        {!isActive && (
          <button
            type="button"
            onClick={() => setIsActive(true)}
            className="rounded-md border border-neutral-300 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
          >
            Edit section
          </button>
        )}
      </div>
      {isActive ? (
        <form onSubmit={handleSave}>
          {children}
          <div className="mt-2 flex items-center gap-3">
            <button
              type="submit"
              disabled={isPending}
              className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isPending ? "Saving…" : "Save changes"}
            </button>
            <button type="button" onClick={() => setIsActive(false)} className="text-xs text-neutral-500 hover:underline">
              Cancel
            </button>
            {error && <span className="text-xs text-red-600">{error}</span>}
          </div>
        </form>
      ) : (
        children
      )}
    </LineItemEditModeContext.Provider>
  );
}
