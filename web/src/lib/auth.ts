import { cache } from "react";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  buildSessionValue,
  isSessionStale,
  parseSessionValue,
} from "@/lib/session";

export { hashPassword, verifyPassword } from "@/lib/session";

export async function createSession(userId: string): Promise<void> {
  // Fetched fresh (not trusted from a caller-supplied value) so the
  // embedded claim always reflects the CURRENT passwordChangedAt at the
  // moment this specific session is issued -- see session.ts's
  // buildSessionValue and this file's own getCurrentUser.
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordChangedAt: true } });
  const store = await cookies();
  store.set(SESSION_COOKIE, buildSessionValue(userId, user.passwordChangedAt), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

// Wrapped in React's cache() so the many call sites that each need "who's
// logged in" (the (app) layout's nav bar, a page's own auth gate, a Server
// Action re-checking access, ...) collapse into one DB lookup per request
// instead of one each -- confirmed the layout and this exact estimate page
// both call this independently, meaning every page load was already paying
// for it twice before this. Safe by construction: cache() scopes to the
// single request/render, so it can never leak a user across requests, and
// there's nothing here for a mutation to invalidate mid-request (the
// session cookie itself can't change during one render pass).
export const getCurrentUser = cache(async () => {
  const store = await cookies();
  const session = parseSessionValue(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const user = await db.user.findFirst({
    where: { id: session.userId, deletedAt: null },
    select: { id: true, name: true, email: true, systemRole: true, passwordChangedAt: true },
  });
  if (!user) return null;
  // A session issued before the user's password was last changed is
  // stale -- reject it even though its signature/expiry are still
  // technically valid, so a stolen/leaked session cookie (or any other
  // still-open browser) stops working the instant the legitimate owner
  // changes their password. See session.ts's isSessionStale for the
  // actual (directly unit-tested) comparison.
  if (isSessionStale(session, user)) return null;
  const { passwordChangedAt: _passwordChangedAt, ...publicUser } = user;
  return publicUser;
});

// Server Actions under /admin re-check this themselves rather than trusting
// the admin layout alone -- Next's own proxy docs warn a route reorganized
// later could silently drop layout coverage for a Server Action, so this is
// the actual enforcement point, not a UI nicety.
export async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || (user.systemRole !== "ADMIN" && user.systemRole !== "SUPER_ADMIN")) {
    throw new Error("Admin access required");
  }
  return user;
}

export async function requireSuperAdmin() {
  const user = await getCurrentUser();
  if (!user || user.systemRole !== "SUPER_ADMIN") {
    throw new Error("Super admin access required");
  }
  return user;
}
