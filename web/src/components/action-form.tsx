"use client";

import { startTransition, useActionState, type FormEvent, type ReactNode } from "react";
import { StatusBanner } from "@/components/ui";
import type { ActionResult } from "@/lib/user-error";

// A <form> for a Server Action that returns an ActionResult (see
// src/lib/user-error.ts) -- shows a returned validation error inline above
// the fields instead of the action throwing into an error boundary, where
// production would only ever show a generic message.
//
// Submits via onSubmit + startTransition rather than <form action>
// directly: React auto-resets an uncontrolled form after every form
// action completes, including one that returned an error, which would wipe
// whatever the user just typed at exactly the moment we're telling them
// what to fix. Driving the dispatch manually skips that reset. A disabled
// <fieldset> stands in for SubmitButton's useFormStatus (which only
// tracks <form action> submissions) and also blocks a double-submit.
//
// Deliberately opt-in per form, not a blanket replacement for every
// <form action> in the app -- see estimates/actions.ts's addSectionAction
// comment for a real page where useActionState never settled. Keep it to
// forms whose pages are known to be light, and verify live on real data.
export function ActionForm({
  action,
  className,
  children,
}: {
  action: (prevState: ActionResult, formData: FormData) => Promise<ActionResult>;
  className?: string;
  children: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, undefined);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {state?.error && (
        <div role="alert" aria-live="polite">
          <StatusBanner kind="error">{state.error}</StatusBanner>
        </div>
      )}
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
