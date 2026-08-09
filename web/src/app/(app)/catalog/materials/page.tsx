import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, Pagination, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

const PAGE_SIZE = 25;

export default async function MaterialsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const { page: pageParam } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const where = { deletedAt: null };
  const [materials, total] = await Promise.all([
    db.material.findMany({
      where,
      orderBy: [{ category: "asc" }, { name: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    db.material.count({ where }),
  ]);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Materials"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href="/catalog/materials/new">New material</LinkButton>}
      />
      {materials.length === 0 ? (
        <EmptyState message="No materials yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {materials.map((material) => (
              <li key={material.id}>
                <Link
                  href={`/catalog/materials/${material.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">{material.name}</div>
                    {material.category && (
                      <div className="text-sm text-neutral-500">{material.category}</div>
                    )}
                  </div>
                  <div className="text-sm font-medium text-neutral-700">
                    ${material.currentUnitCost.toString()}
                    {material.unit ? ` / ${material.unit}` : ""}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Pagination page={page} totalPages={totalPages} basePath="/catalog/materials" />
    </div>
  );
}
