import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, parseSessionValue } from "@/lib/session";

// Next 16 renamed middleware.ts -> proxy.ts (same mechanism, new name/export).
// This is the B1 access-control gate: every route requires a valid signed
// session cookie except /login itself. Only checks the cookie's signature
// and expiry here (no DB hit) -- Server Actions still call getCurrentUser()
// from src/lib/auth.ts where they need the real user record, since Next's
// own docs warn a matcher change could silently drop proxy coverage for a
// Server Action and this should not be the only line of defense forever.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/login") return NextResponse.next();

  const session = parseSessionValue(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    // Everything except static assets, image optimization, and favicon --
    // deliberately still covers /_next/data per Next's own guidance, to
    // avoid a protected page whose data route leaks through unprotected.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
