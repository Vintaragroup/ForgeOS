import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { deleteCategory, updateCategory } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";
import { ConfirmForm } from "@/components/confirm-form";

export default async function CategoryDetailPage(props: PageProps<"/catalog/categories/[id]">) {
  const { id } = await props.params;
  const [category, categories] = await Promise.all([
    db.category.findFirst({ where: { id, deletedAt: null } }),
    db.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } }),
  ]);
  if (!category) notFound();

  const hasChildren = categories.some((c) => c.parentId === category.id);
  const parentIdsWithChildren = new Set(categories.filter((c) => c.parentId).map((c) => c.parentId));
  const parentOptions = categories.filter(
    (c) => !c.parentId && c.id !== category.id && !parentIdsWithChildren.has(c.id),
  );

  const updateCategoryWithId = updateCategory.bind(null, category.id);
  const deleteCategoryWithId = deleteCategory.bind(null, category.id);

  return (
    <div>
      <PageHeader title={category.name} backHref="/catalog/categories" backLabel="Categories" />
      <Card className="p-6">
        <form action={updateCategoryWithId} className="flex flex-col gap-4">
          <Field label="Name" name="name" defaultValue={category.name} required />
          {hasChildren ? (
            <p className="text-sm text-neutral-500">
              This category has its own sub-categories, so it must stay top-level (only one level of nesting is
              supported). Move its sub-categories out first if you want to nest this one under something else.
            </p>
          ) : (
            <SelectField
              label="Parent category"
              name="parentId"
              defaultValue={category.parentId ?? ""}
              options={[
                { value: "", label: "— none (top-level) —" },
                ...parentOptions.map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          )}
          <Field label="Sort order" name="sortOrder" type="number" defaultValue={String(category.sortOrder)} required />
          <label className="flex items-center gap-1.5 text-sm text-neutral-700">
            <input type="checkbox" name="isLumpSum" defaultChecked={category.isLumpSum} />
            Lump sum (description + price only, no qty/unit columns -- e.g. Labor, Shipping)
          </label>
          <label className="flex items-center gap-1.5 text-sm text-neutral-700">
            <input type="checkbox" name="isShowService" defaultChecked={category.isShowService} />
            Show service (rolls into the "Show Services" subtotal instead of "Rental Components")
          </label>
          <div className="flex gap-3">
            <Button>Save changes</Button>
          </div>
        </form>
        <ConfirmForm
          action={deleteCategoryWithId}
          confirmMessage={
            hasChildren
              ? "Delete this category? Its sub-categories will become top-level categories. This can't be undone."
              : "Delete this category? This can't be undone."
          }
          className="mt-4 border-t border-neutral-200 pt-4"
        >
          <Button variant="danger">Delete category</Button>
        </ConfirmForm>
      </Card>
    </div>
  );
}
