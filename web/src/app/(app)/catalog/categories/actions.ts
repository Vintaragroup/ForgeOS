"use server";

import { db } from "@/lib/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

export async function createCategory(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("Category name is required");
  const sortOrder = parseSortOrder(formData.get("sortOrder"));

  await db.category.create({
    data: {
      name,
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

  await db.category.update({
    where: { id },
    data: {
      name,
      parentId,
      sortOrder,
      isLumpSum: formData.get("isLumpSum") === "on",
      isShowService: formData.get("isShowService") === "on",
    },
  });

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
