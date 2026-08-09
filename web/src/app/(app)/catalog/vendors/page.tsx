import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, Pagination, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const where = { deletedAt: null };
  const [vendors, total] = await Promise.all([
    db.vendor.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.vendor.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Vendors"
        backHref="/catalog"
        backLabel="Catalog"
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
      <Pagination page={page} totalPages={totalPages} basePath="/catalog/vendors" />
    </div>
  );
}
