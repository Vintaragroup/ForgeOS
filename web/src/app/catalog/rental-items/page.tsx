import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

export default async function RentalItemsPage() {
  const items = await db.rentalItem.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <PageHeader
        title="Rental items"
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
    </div>
  );
}
