"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createVendor(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Vendor name is required");

  await db.vendor.create({
    data: {
      name,
      contactInfo: emptyToNull(formData.get("contactInfo")),
      category: emptyToNull(formData.get("category")),
    },
  });

  revalidatePath("/catalog/vendors");
  redirect("/catalog/vendors");
}

export async function updateVendor(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Vendor name is required");

  await db.vendor.update({
    where: { id },
    data: {
      name,
      contactInfo: emptyToNull(formData.get("contactInfo")),
      category: emptyToNull(formData.get("category")),
    },
  });

  revalidatePath("/catalog/vendors");
  redirect("/catalog/vendors");
}

// Admin-only -- see catalog/categories/actions.ts's deleteCategory for
// the full rationale.
export async function deleteVendor(id: string) {
  await requireAdmin();
  await db.vendor.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/vendors");
  redirect("/catalog/vendors");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
