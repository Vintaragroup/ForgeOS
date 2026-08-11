"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createTaxRate(formData: FormData) {
  const state = parseState(formData.get("state"));

  await db.taxRate.create({
    data: {
      state,
      city: emptyToNull(formData.get("city")),
      label: emptyToNull(formData.get("label")),
      rate: parseRate(formData.get("rate")),
    },
  });

  revalidatePath("/catalog/tax-rates");
  redirect("/catalog/tax-rates");
}

export async function updateTaxRate(id: string, formData: FormData) {
  const state = parseState(formData.get("state"));

  await db.taxRate.update({
    where: { id },
    data: {
      state,
      city: emptyToNull(formData.get("city")),
      label: emptyToNull(formData.get("label")),
      rate: parseRate(formData.get("rate")),
    },
  });

  revalidatePath("/catalog/tax-rates");
  redirect("/catalog/tax-rates");
}

export async function deleteTaxRate(id: string) {
  await db.taxRate.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/tax-rates");
  redirect("/catalog/tax-rates");
}

function parseState(value: FormDataEntryValue | null): string {
  const state = String(value ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(state)) throw new Error("State must be a 2-letter code, e.g. FL");
  return state;
}

// Entered as a percentage (e.g. "6.5") -- stored as a decimal fraction
// (0.0650) since that's what multiplies directly against a taxable total.
function parseRate(value: FormDataEntryValue | null): number {
  const percent = Number(value);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error("Tax rate must be a percentage between 0 and 100");
  }
  return percent / 100;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
