import { db } from "@/lib/db";
import { createCategory } from "../actions";
import { Button, Card, Field, PageHeader, SelectField } from "@/components/ui";

export default async function NewCategoryPage() {
  const categories = await db.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });

  // Only top-level categories with no children of their own are valid
  // parents -- picking a category that already has children would create
  // two levels of nesting, which the proposal PDF/web view don't render
  // (see Category's schema comment).
  const parentIdsWithChildren = new Set(categories.filter((c) => c.parentId).map((c) => c.parentId));
  const parentOptions = categories.filter((c) => !c.parentId && !parentIdsWithChildren.has(c.id));

  return (
    <div>
      <PageHeader title="New category" backHref="/catalog/categories" backLabel="Categories" />
      <Card className="p-6">
        <form action={createCategory} className="flex flex-col gap-4">
          <Field label="Name" name="name" required placeholder="e.g. Rigging" />
          <SelectField
            label="Parent category"
            name="parentId"
            defaultValue=""
            options={[
              { value: "", label: "— none (top-level) —" },
              ...parentOptions.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <Field
            label="Sort order"
            name="sortOrder"
            type="number"
            defaultValue={String(categories.length)}
            required
          />
          <label className="flex items-center gap-1.5 text-sm text-neutral-700">
            <input type="checkbox" name="isLumpSum" />
            Lump sum (description + price only, no qty/unit columns -- e.g. Labor, Shipping)
          </label>
          <label className="flex items-center gap-1.5 text-sm text-neutral-700">
            <input type="checkbox" name="isShowService" />
            Show service (rolls into the "Show Services" subtotal instead of "Rental Components")
          </label>
          <div>
            <Button>Create category</Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
