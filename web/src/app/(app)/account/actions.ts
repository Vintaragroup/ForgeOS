"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { getCurrentUser, hashPassword, verifyPassword } from "@/lib/auth";
import { checkRateLimit, RateLimitError } from "@/lib/rate-limit";

const CHANGE_PASSWORD_ATTEMPT_LIMIT = 8;
const CHANGE_PASSWORD_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

// B22: before this, the only way to change a password was
// `npm run set-password` from the host -- fine for onboarding (see
// Batch 1's write-up on why passwords are never set through a web form),
// but a logged-in user should be able to change their own without asking
// someone with terminal access. This still isn't that unauthenticated
// "claim your account" endpoint -- it requires the current password AND
// an existing session, so the trust boundary is unchanged.
export async function changePasswordAction(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const fail = (reason: string) => redirect(`/account?error=${encodeURIComponent(reason)}`);

  // B20: rate-limited by user id -- this endpoint accepts a guessed
  // "current password," so it's exactly the kind of action B20 is about.
  try {
    checkRateLimit(`change-password:${user.id}`, CHANGE_PASSWORD_ATTEMPT_LIMIT, CHANGE_PASSWORD_ATTEMPT_WINDOW_MS);
  } catch (err) {
    if (err instanceof RateLimitError) fail(err.message);
    throw err;
  }

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (newPassword.length < 8) fail("Password must be at least 8 characters.");
  if (newPassword !== confirmPassword) fail("New password and confirmation don't match.");

  const dbUser = await db.user.findFirst({ where: { id: user.id, deletedAt: null } });
  if (!dbUser?.passwordHash || !(await verifyPassword(currentPassword, dbUser.passwordHash))) {
    fail("Current password is incorrect.");
  }

  const passwordHash = await hashPassword(newPassword);
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });

  redirect("/account?success=1");
}
