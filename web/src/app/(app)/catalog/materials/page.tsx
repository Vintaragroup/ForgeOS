import { db } from "@/lib/db";
import { Card, CollapsibleSection, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

// Large categories (BeMatrix System, Printing Substrates) default closed
// so the page doesn't open on a wall of 50+ rows -- smaller categories
// stay open since there's nothing to hide.
const DEFAULT_OPEN_THRESHOLD = 20;

export default async function MaterialsPage() {
  const materials = await db.material.findMany({
    where: { deletedAt: null },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });

  const groups = new Map<string, typeof materials>();
  for (const material of materials) {
    const key = material.category ?? "Uncategorized";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(material);
  }
  const sortedGroups = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

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
        <div className="flex flex-col gap-4">
          {sortedGroups.map(([category, items]) => (
            <CollapsibleSection
              key={category}
              title={`${category} (${items.length})`}
              defaultOpen={items.length <= DEFAULT_OPEN_THRESHOLD}
            >
              <Card className="overflow-hidden">
                <ul className="divide-y divide-neutral-200">
                  {items.map((material) => (
                    <li key={material.id}>
                      <Link
                        href={`/catalog/materials/${material.id}`}
                        className="flex items-center justify-between px-5 py-3 hover:bg-neutral-50"
                      >
                        <div className="font-medium">{material.name}</div>
                        <div className="text-sm font-medium text-neutral-700">
                          ${material.currentUnitCost.toString()}
                          {material.unit ? ` / ${material.unit}` : ""}
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

