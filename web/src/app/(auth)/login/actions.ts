"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { createSession, verifyPassword } from "@/lib/auth";

export async function loginAction(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/");

  const user = await db.user.findFirst({ where: { email, deletedAt: null } });
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  await createSession(user.id);
  redirect(next.startsWith("/") ? next : "/");
}
