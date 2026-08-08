import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function MaterialsPage() {
  const materials = await db.material.findMany({
    where: { deletedAt: null },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  return (
    <div>
      <PageHeader
        title="Materials"
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
    </div>
  );
}
