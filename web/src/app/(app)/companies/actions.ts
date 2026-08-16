"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createCompany(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Company name is required");

  const company = await db.company.create({
    data: {
      name,
      billingAddress: emptyToNull(formData.get("billingAddress")),
      industry: emptyToNull(formData.get("industry")),
      taxRateId: emptyToNull(formData.get("taxRateId")),
    },
  });

  revalidatePath("/companies");
  redirect(`/companies/${company.id}`);
}

export async function updateCompany(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Company name is required");

  await db.company.update({
    where: { id },
    data: {
      name,
      billingAddress: emptyToNull(formData.get("billingAddress")),
      industry: emptyToNull(formData.get("industry")),
      taxRateId: emptyToNull(formData.get("taxRateId")),
    },
  });

  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
  redirect(`/companies/${id}`);
}

// Admin-only -- widest-blast-radius, hardest-to-reverse action on data
// every opportunity referencing this company can see. See catalog/
// categories/actions.ts's deleteCategory for the full rationale.
export async function deleteCompany(id: string) {
  await requireAdmin();
  await db.company.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/companies");
  redirect("/companies");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
