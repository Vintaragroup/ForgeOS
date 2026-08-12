import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function CategoriesPage() {
  const categories = await db.category.findMany({
    where: { deletedAt: null },
    orderBy: { sortOrder: "asc" },
  });

  const topLevel = categories.filter((c) => !c.parentId);
  const childrenByParentId = new Map<string, typeof categories>();
  for (const c of categories) {
    if (!c.parentId) continue;
    if (!childrenByParentId.has(c.parentId)) childrenByParentId.set(c.parentId, []);
    childrenByParentId.get(c.parentId)!.push(c);
  }

  return (
    <div>
      <PageHeader
        title="Categories"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href="/catalog/categories/new">New category</LinkButton>}
      />
      <p className="mb-4 text-sm text-neutral-500">
        Controls how the proposal PDF/web view groups and orders line items -- a category with no parent renders
        as its own top-level section (in the order below); a category with a parent renders nested under it. Lump
        sum categories (e.g. Labor) show as a description + price line with no qty/unit columns; Show Service
        categories roll into the "Show Services" subtotal instead of "Rental Components."
      </p>
      {categories.length === 0 ? (
        <EmptyState message="No categories yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {topLevel.map((category) => (
              <li key={category.id}>
                <Link
                  href={`/catalog/categories/${category.id}`}
                  className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                >
                  <span className="font-medium">{category.name}</span>
                  <CategoryFlags category={category} />
                </Link>
                {(childrenByParentId.get(category.id) ?? []).map((child) => (
                  <Link
                    key={child.id}
                    href={`/catalog/categories/${child.id}`}
                    className="flex items-center justify-between border-t border-neutral-100 py-3 pr-5 pl-10 text-sm hover:bg-neutral-50"
                  >
                    <span className="text-neutral-600">{child.name}</span>
                    <CategoryFlags category={child} />
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function CategoryFlags({ category }: { category: { isLumpSum: boolean; isShowService: boolean } }) {
  if (!category.isLumpSum && !category.isShowService) return null;
  return (
    <span className="flex gap-1.5 text-xs text-neutral-400">
      {category.isLumpSum && <span className="rounded-full bg-neutral-100 px-2 py-0.5">Lump sum</span>}
      {category.isShowService && <span className="rounded-full bg-neutral-100 px-2 py-0.5">Show service</span>}
    </span>
  );
}
