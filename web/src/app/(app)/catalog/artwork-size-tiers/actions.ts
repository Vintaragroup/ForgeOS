"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Unlike the schema's own nullable width/height (a size tier's dims were
// never required before this admin page existed -- the only prior
// `.create()` call anywhere in the repo was a test fixture that omitted
// them), this form holds a higher bar: a tier that can't report a real
// dimension isn't useful to the proof-sheet/production-spec prefill this
// page exists for.
function parsePositiveInches(formData: FormData, name: string): number {
  const n = Number(formData.get(name));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Enter a valid ${name} in inches.`);
  return n;
}

function parseFee(formData: FormData): number {
  const n = Number(formData.get("expoProducedFee"));
  if (!Number.isFinite(n) || n < 0) throw new Error("Enter a valid Expo-produced fee.");
  return n;
}

export async function createArtworkSizeTier(formData: FormData) {
  const label = String(formData.get("label") ?? "").trim();
  if (!label) throw new Error("Label is required");

  await db.artworkSizeTier.create({
    data: {
      label,
      width: parsePositiveInches(formData, "width"),
      height: parsePositiveInches(formData, "height"),
      expoProducedFee: parseFee(formData),
      isStandard: formData.get("isStandard") === "on",
    },
  });

  revalidatePath("/catalog/artwork-size-tiers");
  redirect("/catalog/artwork-size-tiers");
}

export async function updateArtworkSizeTier(id: string, formData: FormData) {
  const label = String(formData.get("label") ?? "").trim();
  if (!label) throw new Error("Label is required");

  await db.artworkSizeTier.update({
    where: { id },
    data: {
      label,
      width: parsePositiveInches(formData, "width"),
      height: parsePositiveInches(formData, "height"),
      expoProducedFee: parseFee(formData),
      isStandard: formData.get("isStandard") === "on",
    },
  });

  revalidatePath("/catalog/artwork-size-tiers");
  redirect("/catalog/artwork-size-tiers");
}

// Admin-only -- see catalog/categories/actions.ts's deleteCategory for
// the full rationale.
export async function deleteArtworkSizeTier(id: string) {
  await requireAdmin();
  await db.artworkSizeTier.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/catalog/artwork-size-tiers");
  redirect("/catalog/artwork-size-tiers");
}
