"use client";

import { ErrorFallback } from "@/components/error-fallback";

// No home link -- portal visitors are account-less external clients/
// vendors who arrived on a tokenized link, so there's no "home" page for
// them to go back to; retrying (or reopening their link) is the only path.
export default function PortalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} />;
}
