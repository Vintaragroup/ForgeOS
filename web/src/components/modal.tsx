"use client";

import { type ReactNode } from "react";

// The app's first shared modal primitive -- its own "use client" file
// rather than folded into components/ui.tsx (which every server-rendered
// page already imports Button/Field/etc. from) since a backdrop-click
// handler is a real client-only concern; matches chat-widget.tsx's own
// precedent of being a dedicated client file rather than mixed into the
// mostly-server-safe shared primitives. Deliberately generic (title +
// children + onClose) so the next modal need in this app doesn't
// duplicate this -- proposal-preview-modal.tsx is the first caller.
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-5 py-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  );
}
