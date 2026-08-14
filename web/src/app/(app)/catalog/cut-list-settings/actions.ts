"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { updateCutListSettings } from "@/lib/cut-list-settings-service";

// Unlike materials/actions.ts's parseOptionalPositiveNumber (these three
// settings ARE the fallback, so they always need a real value -- there's
// no "leave it blank" case here the way there is for a per-material
// override).
function parseRequiredPositiveNumber(value: FormDataEntryValue | null, label: string): number {
  const n = Number(String(value ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number`);
  return n;
}

export async function updateCutListSettingsAction(formData: FormData) {
  await updateCutListSettings({
    defaultKerf: parseRequiredPositiveNumber(formData.get("defaultKerf"), "Default kerf"),
    minRemnantDimension: parseRequiredPositiveNumber(formData.get("minRemnantDimension"), "Minimum remnant size"),
    dragGridSnap: parseRequiredPositiveNumber(formData.get("dragGridSnap"), "Drag grid snap"),
  });

  revalidatePath("/catalog/cut-list-settings");
  redirect("/catalog/cut-list-settings");
}
