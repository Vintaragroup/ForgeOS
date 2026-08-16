"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createRentalItem(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Rental item name is required");

  await db.rentalItem.create({
    data: {
      name,
      unitPrice: parsePrice(formData.get("unitPrice")),
      category: emptyToNull(formData.get("category")),
      priceDerivationNote: emptyToNull(formData.get("priceDerivationNote")),
    },
  });

  revalidatePath("/catalog/rental-items");
  redirect("/catalog/rental-items");
}

export async function updateRentalItem(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Rental item name is required");

  await db.rentalItem.update({
    where: { id },
    data: {
      name,
      unitPrice: parsePrice(formData.get("unitPrice")),
      category: emptyToNull(formData.get("category")),
      priceDerivationNote: emptyToNull(formData.get("priceDerivationNote")),
    },
  });

  revalidatePath("/catalog/rental-items");
  redirect("/catalog/rental-items");
}

// Admin-only -- see catalog/categories/actions.ts's deleteCategory for
// the full rationale.
export async function deleteRentalItem(id: string) {
  await requireAdmin();
  await db.rentalItem.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/rental-items");
  redirect("/catalog/rental-items");
}

function parsePrice(value: FormDataEntryValue | null): number {
  const price = Number(value);
  if (!Number.isFinite(price) || price < 0) throw new Error("Unit price must be a non-negative number");
  return price;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
