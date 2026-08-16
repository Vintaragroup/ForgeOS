"use server";

import { db } from "@/lib/db";
import { LaborRateType, LaborRateTier, LaborUnionStatus } from "@/generated/prisma/enums";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createLaborRate(formData: FormData) {
  const rateType = String(formData.get("rateType")) as LaborRateType;
  const rate = parseRate(formData.get("rate"));
  const isCityMarket = rateType === "CITY_MARKET";

  await db.laborRate.create({
    data: {
      rateType,
      rate,
      departmentCode: emptyToNull(formData.get("departmentCode")),
      departmentName: emptyToNull(formData.get("departmentName")),
      city: emptyToNull(formData.get("city")),
      // Tier/union/notes only apply to CITY_MARKET rows -- see
      // LaborRateTier/LaborUnionStatus's schema comments.
      laborTier: isCityMarket ? (emptyToNull(formData.get("laborTier")) as LaborRateTier | null) : null,
      unionStatus: isCityMarket ? (emptyToNull(formData.get("unionStatus")) as LaborUnionStatus | null) : null,
      notes: isCityMarket ? emptyToNull(formData.get("notes")) : null,
    },
  });

  revalidatePath("/catalog/labor-rates");
  redirect("/catalog/labor-rates");
}

export async function updateLaborRate(id: string, formData: FormData) {
  const rateType = String(formData.get("rateType")) as LaborRateType;
  const rate = parseRate(formData.get("rate"));
  const isCityMarket = rateType === "CITY_MARKET";

  await db.laborRate.update({
    where: { id },
    data: {
      rateType,
      rate,
      departmentCode: emptyToNull(formData.get("departmentCode")),
      departmentName: emptyToNull(formData.get("departmentName")),
      city: emptyToNull(formData.get("city")),
      laborTier: isCityMarket ? (emptyToNull(formData.get("laborTier")) as LaborRateTier | null) : null,
      unionStatus: isCityMarket ? (emptyToNull(formData.get("unionStatus")) as LaborUnionStatus | null) : null,
      notes: isCityMarket ? emptyToNull(formData.get("notes")) : null,
    },
  });

  revalidatePath("/catalog/labor-rates");
  redirect("/catalog/labor-rates");
}

// Admin-only -- see catalog/categories/actions.ts's deleteCategory for
// the full rationale.
export async function deleteLaborRate(id: string) {
  await requireAdmin();
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
