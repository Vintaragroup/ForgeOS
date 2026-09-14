"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Spinner } from "@/components/ui";

// A Server Action form's own <button type="submit"> has no idea the
// action is still running -- Analyze, Generate, Build, Propose, and Run
// [analysis] buttons across this app all kick off a real OpenAI call or
// other multi-second backend work, and with a plain button nothing on
// screen changes between the click and the eventual re-render, so a user
// who doesn't notice keeps clicking, firing off another full run each
// time. General rule, not a one-off: every such button in the app should
// go through this component. useFormStatus only reads from a child of
// the <form> it's inside (not the form itself), which is why this is its
// own component rather than a prop on the existing button markup.
//
// Same variant palette as ui.tsx's Button (kept as a separate literal
// copy rather than a shared import -- Button/LinkButton in that file
// already duplicate the same three strings between themselves, so a
// third copy here matches the codebase's existing precedent rather than
// introducing new sharing where there wasn't any before). Passing
// `variant` renders exactly like Button; omitting it renders a bare
// button for a caller styling its own (Analyze/Re-analyze's small text
// links, not a real button, being the reason this mode exists at all).
const VARIANT_STYLES = {
  primary: "bg-brand-black text-white hover:bg-brand-navy",
  secondary: "bg-white text-neutral-900 border border-neutral-300 hover:bg-neutral-50",
  danger: "bg-red-600 text-white hover:bg-red-700",
};

export function SubmitButton({
  children,
  pendingText,
  variant,
  className,
  title,
  "aria-label": ariaLabel,
}: {
  children: ReactNode;
  pendingText: string;
  variant?: "primary" | "secondary" | "danger";
  className?: string;
  title?: string;
  "aria-label"?: string;
}) {
  const { pending } = useFormStatus();
  const variantClasses = variant ? `rounded-md px-4 py-2 text-sm font-medium transition-colors ${VARIANT_STYLES[variant]}` : "";
  return (
    <button
      type="submit"
      disabled={pending}
      title={title}
      aria-label={ariaLabel}
      className={`inline-flex items-center justify-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-60 ${variantClasses} ${className ?? ""}`}
    >
      {pending && <Spinner />}
      {pending ? pendingText : children}
    </button>
  );
}
