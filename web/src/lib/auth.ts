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
    select: { id: true, name: true, email: true },
  });
}
