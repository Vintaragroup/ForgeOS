import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, Pagination, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function RentalItemsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const where = { deletedAt: null };
  const [items, total] = await Promise.all([
    db.rentalItem.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.rentalItem.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
        <Card>
          <ul className="divide-y divide-neutral-200">
            {items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/catalog/rental-items/${item.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
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
      )}
      <Pagination page={page} totalPages={totalPages} basePath="/catalog/rental-items" />
    </div>
  );
}
