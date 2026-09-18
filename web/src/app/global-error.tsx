"use client";

import { ErrorFallback } from "@/components/error-fallback";
import "./globals.css";

// Last-resort boundary for a throw in one of the three root layouts
// themselves ((app), (portal), (auth) -- each is its own root layout, so
// their own error.tsx files can't catch a layout-level failure, e.g.
// (app)/layout.tsx's getCurrentUser() query). Replaces the whole document,
// so it has to bring its own <html>/<body> and stylesheet.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body className="min-h-full bg-neutral-50 px-6 py-16 text-neutral-900 antialiased">
        <title>Something went wrong</title>
        <ErrorFallback error={error} retry={retry} />
      </body>
    </html>
  );
}
