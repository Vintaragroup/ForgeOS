"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { requireEstimateAccess } from "@/lib/opportunity-access";
import { assertUnlocked } from "@/lib/estimate-service";
import {
  optimizeNestingForMaterial,
  optimizeNestingForVersion,
  validateManualLayout,
  type PlacedPart,
} from "@/lib/cut-list-nesting-service";

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function cutListPath(estimateId: string, versionId: string): string {
  return `/estimates/${estimateId}/versions/${versionId}/cut-list`;
}

// Shared by every mutating action below -- redirect() is deliberately
// called by each caller AFTER its own try/catch, not from in here, for
// the same reason optimizeMaterialAction's original comment gives: Next's
// redirect() throws internally to unwind the render, and calling it
// inside a try would make that same try's catch swallow it as if it were
// a real error.
function errorRedirectPath(estimateId: string, versionId: string, message: string): string {
  return `${cutListPath(estimateId, versionId)}?optimizeError=${encodeURIComponent(message)}`;
}

// Cut-list phase 6: none of these four actions checked
// EstimateVersion.isLocked at all -- every other estimate mutation
// (estimate-service.ts's addSection/addLineItem/etc.) already goes
// through assertUnlocked first. A cut list could silently keep changing
// after the version it belongs to was locked/accepted, with no record of
// what production actually cut vs. what's on file today. assertUnlocked
// now guards all four, same as everywhere else in the app.
export async function addCutListPartAction(estimateId: string, versionId: string, formData: FormData) {
  await requireEstimateAccess(estimateId);
  let errorMessage: string | null = null;
  try {
    await assertUnlocked(versionId);

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

    // Optional -- ties this part back to the specific priced LineItem
    // it's fabrication detail for (cut-list-part-fields.tsx's picker).
    // Validated against this same estimate version rather than trusted
    // blindly, since it's a plain form value.
    const lineItemIdRaw = emptyToNull(formData.get("lineItemId"));
    let lineItemId: string | null = null;
    if (lineItemIdRaw) {
      const lineItem = await db.lineItem.findFirst({ where: { id: lineItemIdRaw, section: { estimateVersionId: versionId } } });
      if (!lineItem) throw new Error("That line item no longer belongs to this estimate version.");
      lineItemId = lineItem.id;
    }

    await db.cutListPart.create({
      data: { estimateVersionId: versionId, materialId, description, width, length, qty, grainConstrained, edgeBanding, lineItemId },
    });
    // Any existing CutSheet layout for this material was computed from
    // the old part list -- it's now stale (missing this new part
    // entirely), not just imprecise. Clearing it, rather than leaving a
    // wrong-but-present result on screen, forces a fresh Optimize before
    // any sheets/cost/waste numbers show again -- same "wrong answer is
    // worse than a visible gap" posture the catalog-match scorer's own
    // header comment argues for elsewhere in this app.
    await db.cutSheet.deleteMany({ where: { estimateVersionId: versionId, materialId } });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(cutListPath(estimateId, versionId));
  redirect(errorMessage ? errorRedirectPath(estimateId, versionId, errorMessage) : cutListPath(estimateId, versionId));
}

export async function deleteCutListPartAction(estimateId: string, versionId: string, partId: string) {
  await requireEstimateAccess(estimateId);
  let errorMessage: string | null = null;
  try {
    await assertUnlocked(versionId);
    const part = await db.cutListPart.delete({ where: { id: partId } });
    // Same staleness reasoning as addCutListPartAction -- confirmed
    // live: without this, the cut list summary kept showing a
    // material's old sheet count/cost/waste after its only part was
    // deleted, computed from parts that no longer exist.
    await db.cutSheet.deleteMany({ where: { estimateVersionId: versionId, materialId: part.materialId } });
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(cutListPath(estimateId, versionId));
  redirect(errorMessage ? errorRedirectPath(estimateId, versionId, errorMessage) : cutListPath(estimateId, versionId));
}

// optimizeNestingForMaterial throws on a genuinely bad setup (a
// grain-constrained part that only fits rotated, a part bigger than the
// stock, etc.) -- same "never an uncaught exception for an expected,
// actionable error" posture as import-actions.ts's AiNotConfiguredError
// handling, just via a redirect+query-param result instead of a thrown
// Error, since buildFullEstimateFromDocumentsAction already established
// that pattern for a materially identical case (an action whose outcome
// is worth showing, not just success/fail).
export async function optimizeMaterialAction(estimateId: string, versionId: string, materialId: string) {
  await requireEstimateAccess(estimateId);
  let errorMessage: string | null = null;
  try {
    await assertUnlocked(versionId);
    await optimizeNestingForMaterial(versionId, materialId);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(cutListPath(estimateId, versionId));
  redirect(errorMessage ? errorRedirectPath(estimateId, versionId, errorMessage) : cutListPath(estimateId, versionId));
}

export async function optimizeAllMaterialsAction(estimateId: string, versionId: string) {
  await requireEstimateAccess(estimateId);
  let errorMessage: string | null = null;
  let result: Awaited<ReturnType<typeof optimizeNestingForVersion>> | null = null;
  try {
    await assertUnlocked(versionId);
    result = await optimizeNestingForVersion(versionId);
  } catch (err) {
    // optimizeNestingForVersion itself already catches a per-material
    // optimize failure into its own `skipped` list -- a throw reaching
    // here means something outside that (assertUnlocked, a genuinely
    // unexpected DB error). Previously this had no try/catch at all and
    // would crash to Next's error boundary; now it surfaces the same way
    // every other action here does, instead of a hard crash.
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  revalidatePath(cutListPath(estimateId, versionId));
  redirect(
    errorMessage
      ? errorRedirectPath(estimateId, versionId, errorMessage)
      : `${cutListPath(estimateId, versionId)}?optimizeAllResult=${encodeURIComponent(JSON.stringify(result))}`,
  );
}

// Cut-list phase 6, feature 5: persists a manually dragged-and-dropped
// layout. Unlike every action above, this is called directly from a
// client component (cut-sheet-diagram-editor.tsx), not bound to a
// <form action> -- same "Server Action invoked directly, not via a form"
// pattern chat-widget.tsx's sendWidgetMessageAction already established
// for this app. So this throws a plain Error on failure (caught by the
// client's own try/catch inside startTransition) instead of the
// redirect+query-param pattern the form-bound actions above use, which
// only makes sense for a full-page navigation.
export async function updateCutSheetLayoutAction(
  estimateId: string,
  versionId: string,
  materialId: string,
  sheetNumber: number,
  parts: PlacedPart[],
): Promise<void> {
  await requireEstimateAccess(estimateId);
  await assertUnlocked(versionId);

  const sheet = await db.cutSheet.findFirst({
    where: { estimateVersionId: versionId, materialId, sheetNumber },
    include: { consumedRemnant: true },
  });
  if (!sheet) throw new Error(`Sheet ${sheetNumber} not found -- it may have been re-optimized since this page loaded.`);

  const material = await db.material.findUniqueOrThrow({ where: { id: materialId } });
  const sheetWidth = sheet.consumedRemnant ? sheet.consumedRemnant.width.toNumber() : material.stockWidth!.toNumber();
  const sheetLength = sheet.consumedRemnant ? sheet.consumedRemnant.length.toNumber() : material.stockLength!.toNumber();

  validateManualLayout(parts, sheet.layout as unknown as PlacedPart[], sheetWidth, sheetLength);

  await db.$transaction(async (tx) => {
    await tx.cutSheet.update({ where: { id: sheet.id }, data: { layout: parts as unknown as Prisma.InputJsonValue } });
    // The freeRects-based leftover this sheet may have generated no
    // longer describes real leftover space once a human has manually
    // repositioned its parts -- same cleanup optimizeNestingForMaterial
    // already applies to a superseded auto-computed layout, just
    // triggered by a manual save here instead of a re-optimize.
    await tx.materialRemnant.deleteMany({ where: { generatedByCutSheetId: sheet.id } });
  });

  revalidatePath(cutListPath(estimateId, versionId));
}
