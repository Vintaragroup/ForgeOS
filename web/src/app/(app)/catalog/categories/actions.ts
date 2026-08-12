"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createCategory(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Category name is required");
  const sortOrder = parseSortOrder(formData.get("sortOrder"));
  const key = await uniqueKeyFor(name);

  await db.category.create({
    data: {
      name,
      key,
      parentId: emptyToNull(formData.get("parentId")),
      sortOrder,
      isLumpSum: formData.get("isLumpSum") === "on",
      isShowService: formData.get("isShowService") === "on",
    },
  });

  revalidatePath("/catalog/categories");
  redirect("/catalog/categories");
}

export async function updateCategory(id: string, formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Category name is required");
  const sortOrder = parseSortOrder(formData.get("sortOrder"));
  const parentId = emptyToNull(formData.get("parentId"));
  if (parentId === id) throw new Error("A category cannot be its own parent");

  // LineItem.category is a plain string matched against Category.name (see
  // proposal-view-model.ts's isKnownCategory), not a foreign key -- a
  // rename with no cascade orphans every existing LineItem still holding
  // the old name, silently dropping it into the "Other" fallback bucket on
  // every proposal. A real job's "Custom Build" -> "Custom Build / Rental"
  // rename did exactly this to 18 line items before this cascade existed.
  // `key` is deliberately never touched here -- it's the stable identifier
  // line-item-category.ts's heuristics resolve against for every *future*
  // categorization decision (see Category.key's schema comment), so a
  // rename only ever changes what a category is called, never what
  // future line items resolve it by.
  const existing = await db.category.findUniqueOrThrow({ where: { id } });
  await db.$transaction([
    db.category.update({
      where: { id },
      data: {
        name,
        parentId,
        sortOrder,
        isLumpSum: formData.get("isLumpSum") === "on",
        isShowService: formData.get("isShowService") === "on",
      },
    }),
    ...(existing.name !== name
      ? [db.lineItem.updateMany({ where: { category: existing.name }, data: { category: name } })]
      : []),
  ]);

  revalidatePath("/catalog/categories");
  redirect("/catalog/categories");
}

export async function deleteCategory(id: string) {
  // Orphan children rather than blocking the delete or cascading further
  // deletes -- they become top-level categories in their own right, still
  // real, still usable, just no longer nested under the deleted parent.
  await db.$transaction([
    db.category.updateMany({ where: { parentId: id }, data: { parentId: null } }),
    db.category.update({ where: { id }, data: { deletedAt: new Date() } }),
  ]);
  revalidatePath("/catalog/categories");
  redirect("/catalog/categories");
}

function parseSortOrder(value: FormDataEntryValue | null): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// No form field for this -- key is an internal stability mechanism, not
// something an estimator names themselves (see Category.key's schema
// comment). Derived once at creation from the category's initial name and
// never touched again, even if that name is later edited.
async function uniqueKeyFor(name: string): Promise<string> {
  const base = slugify(name) || "category";
  let candidate = base;
  let suffix = 2;
  while (await db.category.findUnique({ where: { key: candidate } })) {
    candidate = `${base}_${suffix++}`;
  }
  return candidate;
}
