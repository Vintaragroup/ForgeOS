"use client";

import { useEffect } from "react";
import Link from "next/link";

// Shared body for every route group's error.tsx -- before these existed,
// any uncaught throw (a Server Action validation error, a failed query)
// fell through to Next's raw dev overlay / bare "Application error" page.
//
// Never shows error.message in production: Next already redacts server-
// thrown messages there (it'd just be a generic string), and a client-
// thrown one could carry internals. The digest is what matches the server
// log line, so it's the useful thing to hand whoever investigates. A
// validation message meant for the user should come back through
// ActionForm/UserError instead (see src/lib/user-error.ts), not land here.
export function ErrorFallback({
  error,
  retry,
  homeHref,
  homeLabel,
}: {
  error: Error & { digest?: string };
  retry: () => void;
  homeHref?: string;
  homeLabel?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const isDev = process.env.NODE_ENV === "development";

  return (
    <div className="mx-auto max-w-lg rounded-lg border border-neutral-200 bg-white px-6 py-8 text-center">
      <h2 className="font-display text-2xl tracking-wide text-neutral-900">Something went wrong</h2>
      <p className="mt-2 text-sm text-neutral-600">
        That didn&apos;t go through. Your last change may not have been saved -- try again, and if it keeps
        happening, pass the reference below along.
      </p>
      {isDev && error.message && (
        <p className="mt-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-left font-mono text-xs text-red-900">
          {error.message}
        </p>
      )}
      {error.digest && <p className="mt-4 font-mono text-xs text-neutral-400">Reference: {error.digest}</p>}
      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="rounded-md bg-brand-black px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-brand-navy"
        >
          Try again
        </button>
        {homeHref && (
          <Link
            href={homeHref}
            className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-900 transition-colors hover:bg-neutral-50"
          >
            {homeLabel ?? "Go home"}
          </Link>
        )}
      </div>
    </div>
  );
}
