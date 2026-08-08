"use server";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createUser(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!name || !email) throw new Error("Name and email are required");
  if (password.length < 8) throw new Error("Password must be at least 8 characters");

  await db.user.create({
    data: {
      name,
      email,
      role: emptyToNull(formData.get("role")),
      department: emptyToNull(formData.get("department")),
      passwordHash: await hashPassword(password),
    },
  });

  revalidatePath("/users");
  redirect("/users");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
