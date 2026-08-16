"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { MaterialType } from "@/generated/prisma/enums";

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
      ...parseStockFields(formData),
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
      ...parseStockFields(formData),
    },
  });

  revalidatePath("/catalog/materials");
  redirect("/catalog/materials");
}

// Cut-list stock fields -- all optional, null for the common case of a
// Material that isn't cuttable stock at all (hardware, adhesives, etc.).
// Only a Material with materialType=SHEET and both stock dimensions set
// is usable by optimizeNestingForMaterial (cut-list-nesting-service.ts).
function parseStockFields(formData: FormData): {
  materialType: MaterialType | null;
  stockWidth: number | null;
  stockLength: number | null;
  thickness: number | null;
  defaultKerf: number | null;
  grainDirectionMatters: boolean;
} {
  const rawType = String(formData.get("materialType") ?? "").trim();
  return {
    materialType: rawType === "SHEET" || rawType === "LINEAR" ? rawType : null,
    stockWidth: parseOptionalPositiveNumber(formData.get("stockWidth")),
    stockLength: parseOptionalPositiveNumber(formData.get("stockLength")),
    thickness: parseOptionalPositiveNumber(formData.get("thickness")),
    defaultKerf: parseOptionalPositiveNumber(formData.get("defaultKerf")),
    grainDirectionMatters: formData.get("grainDirectionMatters") === "on",
  };
}

function parseOptionalPositiveNumber(value: FormDataEntryValue | null): number | null {
  const str = String(value ?? "").trim();
  if (str === "") return null;
  const n = Number(str);
  if (!Number.isFinite(n) || n < 0) throw new Error(`"${str}" isn't a valid non-negative number`);
  return n;
}

// Admin-only -- see catalog/categories/actions.ts's deleteCategory for
// the full rationale.
export async function deleteMaterial(id: string) {
  await requireAdmin();
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
