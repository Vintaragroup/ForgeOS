"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireEstimateAccess } from "@/lib/opportunity-access";
import { optimizeNestingForMaterial, optimizeNestingForVersion } from "@/lib/cut-list-nesting-service";

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function cutListPath(estimateId: string, versionId: string): string {
  return `/estimates/${estimateId}/versions/${versionId}/cut-list`;
}

export async function addCutListPartAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);

  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Part description is required");
  const materialId = String(formData.get("materialId") ?? "").trim();
  if (!materialId) throw new Error("Choose a material");
  const width = Number(formData.get("width"));
  const length = Number(formData.get("length"));
  const qty = Number(formData.get("qty"));
  if (!Number.isFinite(width) || width <= 0) throw new Error("Width must be a positive number");
  if (!Number.isFinite(length) || length <= 0) throw new Error("Length must be a positive number");
  if (!Number.isFinite(qty) || qty < 1) throw new Error("Qty must be at least 1");
  const grainConstrained = formData.get("grainConstrained") === "on";
  const edgeBanding = emptyToNull(formData.get("edgeBanding"));

  await db.cutListPart.create({
    data: { estimateVersionId: versionId, materialId, description, width, length, qty, grainConstrained, edgeBanding },
  });
  // Any existing CutSheet layout for this material was computed from the
  // old part list -- it's now stale (missing this new part entirely),
  // not just imprecise. Clearing it, rather than leaving a wrong-but-
  // present result on screen, forces a fresh Optimize before any
  // sheets/cost/waste numbers show again -- same "wrong answer is worse
  // than a visible gap" posture the catalog-match scorer's own header
  // comment argues for elsewhere in this app.
  await db.cutSheet.deleteMany({ where: { estimateVersionId: versionId, materialId } });

  revalidatePath(cutListPath(estimateId, versionId));
}

export async function deleteCutListPartAction(estimateId: string, versionId: string, partId: string) {
  await requireEstimateAccess(estimateId);
  const part = await db.cutListPart.delete({ where: { id: partId } });
  // Same staleness reasoning as addCutListPartAction -- confirmed live:
  // without this, the cut list summary kept showing a material's old
  // sheet count/cost/waste after its only part was deleted, computed
  // from parts that no longer exist.
  await db.cutSheet.deleteMany({ where: { estimateVersionId: versionId, materialId: part.materialId } });
  revalidatePath(cutListPath(estimateId, versionId));
}

// optimizeNestingForMaterial throws on a genuinely bad setup (a
// grain-constrained part that only fits rotated, a part bigger than the
// stock, etc.) -- same "never an uncaught exception for an expected,
// actionable error" posture as import-actions.ts's AiNotConfiguredError
// handling, just via a redirect+query-param result instead of a thrown
// Error, since buildFullEstimateFromDocumentsAction already established
// that pattern for a materially identical case (an action whose outcome
// is worth showing, not just success/fail). redirect() is deliberately
// called AFTER the try/catch, not inside it -- Next's redirect() throws
// internally to unwind the render, and calling it inside this function's
// own try would make its catch swallow that signal as if it were a real
// error from optimizeNestingForMaterial.
export async function optimizeMaterialAction(estimateId: string, versionId: string, materialId: string) {
  await requireEstimateAccess(estimateId);
  let errorMessage: string | null = null;
  try {
    await optimizeNestingForMaterial(versionId, materialId);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(cutListPath(estimateId, versionId));
  redirect(
    errorMessage
      ? `${cutListPath(estimateId, versionId)}?optimizeError=${encodeURIComponent(errorMessage)}`
      : cutListPath(estimateId, versionId),
  );
}

export async function optimizeAllMaterialsAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  const result = await optimizeNestingForVersion(versionId);
  revalidatePath(cutListPath(estimateId, versionId));
  redirect(`${cutListPath(estimateId, versionId)}?optimizeAllResult=${encodeURIComponent(JSON.stringify(result))}`);
}
