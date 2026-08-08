"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createMaterial(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Material name is required");

  await db.material.create({
    data: {
      name,
      unit: emptyToNull(formData.get("unit")),
      category: emptyToNull(formData.get("category")),
      currentUnitCost: parseCost(formData.get("currentUnitCost")),
      sourceNote: emptyToNull(formData.get("sourceNote")),
    },
  });

  revalidatePath("/catalog/materials");
  redirect("/catalog/materials");
}

export async function updateMaterial(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Material name is required");

  await db.material.update({
    where: { id },
    data: {
      name,
      unit: emptyToNull(formData.get("unit")),
      category: emptyToNull(formData.get("category")),
      currentUnitCost: parseCost(formData.get("currentUnitCost")),
      sourceNote: emptyToNull(formData.get("sourceNote")),
    },
  });

  revalidatePath("/catalog/materials");
  redirect("/catalog/materials");
}

export async function deleteMaterial(id: string) {
  await db.material.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/materials");
  redirect("/catalog/materials");
}

function parseCost(value: FormDataEntryValue | null): number {
  const cost = Number(value);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Unit cost must be a non-negative number");
  return cost;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}
