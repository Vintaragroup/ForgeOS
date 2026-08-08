"use server";

import { db } from "@/lib/db";
import { LaborRateType } from "@/generated/prisma/enums";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createLaborRate(formData: FormData) {
  const rateType = String(formData.get("rateType")) as LaborRateType;
  const rate = parseRate(formData.get("rate"));

  await db.laborRate.create({
    data: {
      rateType,
      rate,
      departmentCode: emptyToNull(formData.get("departmentCode")),
      departmentName: emptyToNull(formData.get("departmentName")),
      city: emptyToNull(formData.get("city")),
    },
  });

  revalidatePath("/catalog/labor-rates");
  redirect("/catalog/labor-rates");
}

export async function updateLaborRate(id: string, formData: FormData) {
  const rateType = String(formData.get("rateType")) as LaborRateType;
  const rate = parseRate(formData.get("rate"));

  await db.laborRate.update({
    where: { id },
    data: {
      rateType,
      rate,
      departmentCode: emptyToNull(formData.get("departmentCode")),
      departmentName: emptyToNull(formData.get("departmentName")),
      city: emptyToNull(formData.get("city")),
    },
  });

  revalidatePath("/catalog/labor-rates");
  redirect("/catalog/labor-rates");
}

export async function deleteLaborRate(id: string) {
  await db.laborRate.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/labor-rates");
  redirect("/catalog/labor-rates");
}

function parseRate(value: FormDataEntryValue | null): number {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0) throw new Error("Rate must be a non-negative number");
  return rate;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
