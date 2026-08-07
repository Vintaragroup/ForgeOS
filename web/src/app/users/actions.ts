"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createUser(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  if (!name || !email) throw new Error("Name and email are required");

  await db.user.create({
    data: {
      name,
      email,
      role: emptyToNull(formData.get("role")),
      department: emptyToNull(formData.get("department")),
    },
  });

  revalidatePath("/users");
  redirect("/users");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
