import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

export default async function VendorsPage() {
  const vendors = await db.vendor.findMany({
    where: { deletedAt: null },
    orderBy: { name: "asc" },
  });

  return (
    <div>
      <PageHeader
        title="Vendors"
        action={<LinkButton href="/catalog/vendors/new">New vendor</LinkButton>}
      />
      {vendors.length === 0 ? (
        <EmptyState message="No vendors yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {vendors.map((vendor) => (
              <li key={vendor.id}>
                <Link
                  href={`/catalog/vendors/${vendor.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div className="font-medium">{vendor.name}</div>
                  {vendor.category && <div className="text-sm text-neutral-500">{vendor.category}</div>}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
