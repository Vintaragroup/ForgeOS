"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSession, verifyPassword } from "@/lib/auth";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit";

// B20: rate-limited by email, not IP -- the point is to stop someone
// brute-forcing one specific account's password, which an email-keyed
// limit does directly without needing to trust a possibly-spoofable
// forwarded-for header behind an unknown proxy setup (no deploy target
// chosen yet, see B3).
const LOGIN_ATTEMPT_LIMIT = 8;
const LOGIN_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  try {
    await checkRateLimit(`login:${email.toLowerCase()}`, LOGIN_ATTEMPT_LIMIT, LOGIN_ATTEMPT_WINDOW_MS);
  } catch (err) {
    if (err instanceof RateLimitError) {
      redirect(`/login?next=${encodeURIComponent(next)}&error=2`);
    }
    throw err;
  }

  // Case-insensitive on purpose -- email is stored @unique (case-sensitive
  // at the DB level), and this lookup used to match on the raw submitted
  // string. Real, reproducible bug, not hypothetical: a user typing their
  // email with different capitalization than however it happened to get
  // stored (their own phone/browser auto-capitalizing the first letter,
  // or however an admin originally entered it via createAdminUser) got
  // "Incorrect email or password" -- indistinguishable from a genuinely
  // wrong password -- even with the exact right one, confirmed by
  // reproducing a real user's report this way. The rate limiter above
  // already treats email as case-insensitive (checkRateLimit keys on
  // email.toLowerCase()); this brings the actual lookup in line with it.
  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" }, deletedAt: null },
  });
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  await createSession(user.id);
  redirect(next.startsWith("/") ? next : "/");
}
