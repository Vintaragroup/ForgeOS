"use client";

import { startTransition, useActionState, useEffect, useRef, type FormEvent, type ReactNode } from "react";
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
  resetOnSuccess = false,
  onSuccess,
  children,
}: {
  action: (prevState: ActionResult, formData: FormData) => Promise<ActionResult>;
  className?: string;
  // For "add another" forms (an alias, a tag) that should come back empty
  // after a successful submit. Off by default: an edit form should keep
  // showing the values that were just saved.
  resetOnSuccess?: boolean;
  // Fired once after a submit that returned no error. For a form the
  // parent opened and should now close -- without it a disclosure form
  // stays open over its own result, looking like nothing happened.
  onSuccess?: () => void;
  children: ReactNode;
}) {
  const [state, dispatch, pending] = useActionState(action, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  const submittedRef = useRef(false);

  // submittedRef is what makes this safe to re-run: it's cleared before
  // anything fires, so a caller passing an inline arrow (which changes
  // identity every render, and whose own setState causes another one)
  // re-enters here and returns immediately rather than firing twice.
  useEffect(() => {
    if (pending || !submittedRef.current) return;
    submittedRef.current = false;
    if (state?.error) return;
    if (resetOnSuccess) formRef.current?.reset();
    onSuccess?.();
  }, [pending, state, resetOnSuccess, onSuccess]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The submitter is passed on purpose: a native submit includes the
    // name/value of the button that did it, and forms that offer several
    // outcomes (Snooze 1 week / 2 weeks / ...) carry the choice that way.
    // Building FormData without it silently drops that field.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const formData = new FormData(event.currentTarget, submitter instanceof HTMLElement ? submitter : null);
    submittedRef.current = true;
    startTransition(() => dispatch(formData));
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className={className}>
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
