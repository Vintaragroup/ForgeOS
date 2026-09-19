"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser, requireAdmin } from "@/lib/auth";
import {
  CATALOG_ITEM_TYPES,
  addCatalogItemAlias,
  createCatalogItem,
  removeCatalogItemAlias,
  retireCatalogItem,
  updateCatalogItem,
  type CatalogItemFields,
} from "@/lib/catalog-item-service";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";
import type { CatalogItemType } from "@/generated/prisma/enums";

// Thin wrappers over catalog-item-service.ts -- validation and the
// number/type invariants live there. Each returns an ActionResult (see
// src/lib/user-error.ts) so ActionForm can show "enter a price" inline
// instead of a redacted error page.

async function requireUser() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  return user;
}

export async function createCatalogItemAction(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser();
  let id: string | undefined;
  const result = await catchUserError(async () => {
    const rawType = String(formData.get("itemType") ?? "");
    if (!CATALOG_ITEM_TYPES.includes(rawType as CatalogItemType)) throw new UserError("Pick an item type.");
    const item = await createCatalogItem(rawType as CatalogItemType, parseFields(formData));
    id = item.id;
  });
  if (result) return result;
  revalidatePath("/catalog/items");
  redirect(`/catalog/items/${id}`);
}

export async function updateCatalogItemAction(
  id: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  await requireUser();
  const result = await catchUserError(() => updateCatalogItem(id, parseFields(formData)));
  if (!result) {
    revalidatePath("/catalog/items");
    revalidatePath(`/catalog/items/${id}`);
  }
  return result;
}

// Admin-only, same as the legacy deleteMaterial -- see
// catalog/categories/actions.ts's deleteCategory for the rationale.
export async function retireCatalogItemAction(id: string) {
  await requireAdmin();
  await retireCatalogItem(id);
  revalidatePath("/catalog/items");
  redirect("/catalog/items");
}

export async function addAliasAction(catalogItemId: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireUser();
  const result = await catchUserError(() =>
    addCatalogItemAlias(catalogItemId, {
      alias: String(formData.get("alias") ?? ""),
      officeCode: String(formData.get("officeCode") ?? "") || null,
      source: String(formData.get("source") ?? "") || null,
    }),
  );
  if (!result) revalidatePath(`/catalog/items/${catalogItemId}`);
  return result;
}

export async function removeAliasAction(catalogItemId: string, aliasId: string) {
  await requireUser();
  await removeCatalogItemAlias(catalogItemId, aliasId);
  revalidatePath(`/catalog/items/${catalogItemId}`);
}

function parseFields(formData: FormData): CatalogItemFields {
  const rawMaterialType = String(formData.get("materialType") ?? "").trim();
  return {
    categoryCode: String(formData.get("categoryCode") ?? "").trim(),
    name: String(formData.get("name") ?? ""),
    description: text(formData.get("description")),
    unit: text(formData.get("unit")),
    unitCost: optionalNumber(formData.get("unitCost"), "Our cost"),
    unitPrice: optionalNumber(formData.get("unitPrice"), "Sell / rental price"),
    sourceNote: text(formData.get("sourceNote")),
    materialType: rawMaterialType === "SHEET" || rawMaterialType === "LINEAR" ? rawMaterialType : null,
    stockWidth: optionalNumber(formData.get("stockWidth"), "Stock width"),
    stockLength: optionalNumber(formData.get("stockLength"), "Stock length"),
    thickness: optionalNumber(formData.get("thickness"), "Thickness"),
    defaultKerf: optionalNumber(formData.get("defaultKerf"), "Default kerf"),
    grainDirectionMatters: formData.get("grainDirectionMatters") === "on",
    tags: String(formData.get("tags") ?? "")
      .split(",")
      .filter((t) => t.trim()),
  };
}

function text(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function optionalNumber(value: FormDataEntryValue | null, label: string): number | null {
  const str = String(value ?? "").trim().replace(/^\$/, "");
  if (str === "") return null;
  const n = Number(str);
  if (!Number.isFinite(n) || n < 0) throw new UserError(`${label} must be a non-negative number, got "${str}".`);
  return n;
}
