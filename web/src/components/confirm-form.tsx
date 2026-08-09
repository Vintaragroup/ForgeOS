"use client";

import type { ReactNode } from "react";

// Wraps a destructive-action form (delete, deactivate) with a confirm
// dialog on submit -- see the UX field report (Aug 2026): "Delete
// opportunity" sat directly under "Save changes" with no confirmation
// step, a real misclick/data-loss risk. Intercepting onSubmit (rather than
// the button's onClick) also catches Enter-key submission, not just clicks.
export function ConfirmForm({
  action,
  confirmMessage,
  className,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  confirmMessage: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <form
      action={action}
      className={className}
      onSubmit={(event) => {
        if (!window.confirm(confirmMessage)) {
          event.preventDefault();
        }
      }}
    >
      {children}
    </form>
  );
}
