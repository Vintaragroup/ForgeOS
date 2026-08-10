import { db } from "@/lib/db";
import { Card, CollapsibleSection, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

// Large categories (Furniture, BeMatrix System) default closed so the
// page doesn't open on a wall of 50+ rows -- smaller categories stay open
// since there's nothing to hide.
const DEFAULT_OPEN_THRESHOLD = 20;

export default async function RentalItemsPage() {
  const items = await db.rentalItem.findMany({
    where: { deletedAt: null },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const groups = new Map<string, typeof items>();
  for (const item of items) {
    const key = item.category ?? "Uncategorized";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(item);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div>
      <PageHeader
        title="Rental items"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href="/catalog/rental-items/new">New rental item</LinkButton>}
      />
      {items.length === 0 ? (
        <EmptyState message="No rental items yet." />
      ) : (
        <div className="flex flex-col gap-4">
          {sortedGroups.map(([category, categoryItems]) => (
            <CollapsibleSection
              key={category}
              title={`${category} (${categoryItems.length})`}
              defaultOpen={categoryItems.length <= DEFAULT_OPEN_THRESHOLD}
            >
              <Card className="overflow-hidden">
                <ul className="divide-y divide-neutral-200">
                  {categoryItems.map((item) => (
                    <li key={item.id}>
                      <Link
                        href={`/catalog/rental-items/${item.id}`}
                        className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                      >
                        <div className="font-medium">{item.name}</div>
                        <div className="text-sm font-medium text-neutral-700">
                          ${item.unitPrice.toString()}
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
            </CollapsibleSection>
          ))}
        </div>
      )}
    </div>
  );
}

