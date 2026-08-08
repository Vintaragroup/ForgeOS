import { cookies } from "next/headers";
import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  buildSessionValue,
  parseSessionValue,
} from "@/lib/session";

export { hashPassword, verifyPassword } from "@/lib/session";

export async function createSession(userId: string): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, buildSessionValue(userId), {
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

export async function getCurrentUser() {
  const store = await cookies();
  const session = parseSessionValue(store.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  return db.user.findFirst({
    where: { id: session.userId, deletedAt: null },
    select: { id: true, name: true, email: true, systemRole: true },
  });
}

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
