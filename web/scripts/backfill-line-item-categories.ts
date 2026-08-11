// One-time (re-runnable) backfill for LineItem.category and
// LineItem.isClientOwned -- see line-item-category.ts. Re-resolves both
// the same way new imports do for every row, including ones already set --
// a resolveLineItemCategory/inferIsClientOwned refinement can correct an
// earlier run's result, not just fill in nulls/false. Idempotent: rows
// that already resolve to the same values are a no-op write.
//
// Run with: npx tsx scripts/backfill-line-item-categories.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadCatalogForMatching, matchDescription } from "../src/lib/catalog-match-service";
import { inferIsClientOwned, resolveLineItemCategory } from "../src/lib/line-item-category";

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const catalog = await loadCatalogForMatching();
  const rows = await db.lineItem.findMany({
    select: { id: true, description: true, category: true, isClientOwned: true },
  });

  let categoryChanged = 0;
  let stillUnresolved = 0;
  let clientOwnedChanged = 0;

  for (const row of rows) {
    const catalogMatch = matchDescription(row.description, catalog);
    const category = resolveLineItemCategory({ catalogCategory: catalogMatch?.category, description: row.description });
    const isClientOwned = inferIsClientOwned(row.description);

    const data: { category?: string; isClientOwned?: boolean } = {};
    if (category && category !== row.category) {
      data.category = category;
      categoryChanged++;
    }
    if (!category) stillUnresolved++;
    // Never un-flag a manually-checked item -- only turn it on from a
    // confident description match, same one-directional caution as
    // category resolution defaulting to "Other" instead of guessing.
    if (isClientOwned && !row.isClientOwned) {
      data.isClientOwned = true;
      clientOwnedChanged++;
    }

    if (Object.keys(data).length > 0) {
      await db.lineItem.update({ where: { id: row.id }, data });
    }
  }

  console.log(
    `Resolved ${categoryChanged} line items to a new category (${stillUnresolved} unresolved -- render as "Other"); flagged ${clientOwnedChanged} as client-owned, out of ${rows.length} total.`,
  );
  await db.$disconnect();
}

main();
