"use server";

import { db } from "@/lib/db";
import { ContactRole } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createContact(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Contact name is required");

  const contact = await db.contact.create({
    data: {
      name,
      email: emptyToNull(formData.get("email")),
      phone: emptyToNull(formData.get("phone")),
      role: String(formData.get("role")) as ContactRole,
      companyId: emptyToNull(formData.get("companyId")),
    },
  });

  revalidatePath("/contacts");
  redirect(`/contacts/${contact.id}`);
}

export async function updateContact(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Contact name is required");

  await db.contact.update({
    where: { id },
    data: {
      name,
      email: emptyToNull(formData.get("email")),
      phone: emptyToNull(formData.get("phone")),
      role: String(formData.get("role")) as ContactRole,
      companyId: emptyToNull(formData.get("companyId")),
    },
  });

  revalidatePath("/contacts");
  revalidatePath(`/contacts/${id}`);
  redirect(`/contacts/${id}`);
}

// Admin-only -- see companies/actions.ts's deleteCompany for the full
// rationale.
export async function deleteContact(id: string) {
  await requireAdmin();
  await db.contact.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/contacts");
  redirect("/contacts");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
