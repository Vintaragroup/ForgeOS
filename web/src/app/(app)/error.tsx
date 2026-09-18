"use client";

import { ErrorFallback } from "@/components/error-fallback";

// Catches anything thrown inside the internal app's pages/actions -- the
// nav/header layout above stays rendered, so the user can still navigate
// away. See ErrorFallback for why the message itself is never shown in
// production.
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} homeHref="/" homeLabel="Back to dashboard" />;
}
