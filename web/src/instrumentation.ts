import type { Instrumentation } from "next";

// B11: structured error logging. This is the scaffold, not the full item --
// onRequestError is Next's own hook for exactly this (fires for Server
// Component, Route Handler, Server Action, and Proxy errors alike, so
// nothing needs a manual try/catch to be covered). Today it writes one
// structured JSON line to stdout; wiring in a real APM (Sentry, etc.) later
// is a one-function change here, once there's a vendor account and DSN --
// deliberately not fabricated in this pass. See README's Auth section for
// the same "don't build past what's real" reasoning applied elsewhere.
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const message = error instanceof Error ? error.message : String(error);
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest?: unknown }).digest)
      : undefined;

  console.error(
    JSON.stringify({
      level: "error",
      at: new Date().toISOString(),
      message,
      digest,
      path: request.path,
      method: request.method,
      routeType: context.routeType,
      routePath: context.routePath,
    }),
  );
};
