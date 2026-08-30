// Shared redirect-with-status convention for server actions whose only
// feedback need is "confirm this plain-text message" -- generalizes
// account/actions.ts's own pre-existing ?success=/?error= param names
// (previously the only place using them, and only the error side ever
// carried a real message; success was a bare "1" flag read page-side)
// into the one convention new actions should default to, instead of each
// feature inventing its own uniquely-named flag. Actions that need to
// carry richer structured data (a count, a JSON result) or need the
// redirect to also drive extra page behavior beyond showing a message
// (e.g. opportunities/actions.ts's updateCollaborators, which must also
// force its own CollapsibleSection back open) keep their own dedicated
// param instead -- both conventions render through components/ui.tsx's
// same StatusBanner either way.

export function statusRedirectPath(path: string, status: { success: string } | { error: string }): string {
  const [key, message] = "success" in status ? ["success", status.success] : ["error", status.error];
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}${key}=${encodeURIComponent(message)}`;
}

export function readStatus(searchParams: Record<string, string | string[] | undefined>): {
  success: string | null;
  error: string | null;
} {
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  return { success: pick(searchParams.success), error: pick(searchParams.error) };
}
