"use server";

import { db } from "@/lib/db";
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
    },
  });

  revalidatePath("/companies");
  revalidatePath(`/companies/${id}`);
  redirect(`/companies/${id}`);
}

export async function deleteCompany(id: string) {
  await db.company.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/companies");
  redirect("/companies");
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
