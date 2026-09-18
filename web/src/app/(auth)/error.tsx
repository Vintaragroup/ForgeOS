"use client";

import { ErrorFallback } from "@/components/error-fallback";

export default function AuthError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} homeHref="/login" homeLabel="Back to sign in" />;
}
