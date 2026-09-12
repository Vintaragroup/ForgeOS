import { db } from "@/lib/db";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import Link from "next/link";

// See opportunities/page.tsx's comment.
export const dynamic = "force-dynamic";

export default async function ArtworkSizeTiersPage() {
  const tiers = await db.artworkSizeTier.findMany({
    where: { deletedAt: null },
    orderBy: { label: "asc" },
  });

  return (
    <div>
      <PageHeader
        title="Artwork size tiers"
        backHref="/catalog"
        backLabel="Catalog"
        action={<LinkButton href="/catalog/artwork-size-tiers/new">New size tier</LinkButton>}
      />
      {tiers.length === 0 ? (
        <EmptyState message="No artwork size tiers yet." />
      ) : (
        <Card>
          <ul className="divide-y divide-neutral-200">
            {tiers.map((tier) => (
              <li key={tier.id}>
                <Link
                  href={`/catalog/artwork-size-tiers/${tier.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-neutral-50"
                >
                  <div>
                    <div className="font-medium">{tier.label}</div>
                    <div className="text-sm text-neutral-500">
                      {tier.width?.toString() ?? "?"}&quot; × {tier.height?.toString() ?? "?"}&quot; — $
                      {tier.expoProducedFee.toString()} Expo-produced
                      {!tier.isStandard && " — not offered to clients"}
                    </div>
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
