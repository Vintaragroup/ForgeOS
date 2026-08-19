"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

// A Server Action form's own <button type="submit"> has no idea the
// action is still running -- Analyze in particular can take many seconds
// (a real OpenAI call), and with a plain button nothing on screen changes
// between the click and the eventual re-render, so a user who doesn't
// notice keeps clicking, firing off another full analysis run each time.
// useFormStatus only works read from a child of the <form> it's inside
// (not the form itself), which is why this is its own component rather
// than a prop on the existing button markup.
export function SubmitButton({
  children,
  pendingText,
  className,
}: {
  children: ReactNode;
  pendingText: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex items-center gap-1 disabled:cursor-not-allowed disabled:opacity-60 ${className ?? ""}`}
    >
      {pending && (
        <svg className="h-3 w-3 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      )}
      {pending ? pendingText : children}
    </button>
  );
}
