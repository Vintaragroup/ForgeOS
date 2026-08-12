// Idempotent (re-runnable) seed of the 12 categories that used to be the
// hardcoded CANONICAL_CATEGORIES constant -- preserves the exact same
// name, order, hierarchy, and rendering flags that constant had, so
// migrating from code to a DB-backed catalog doesn't change any existing
// proposal's output. Run this once during the Category migration; after
// that, categories are managed via /catalog/categories.
//
// Run with: npx tsx scripts/seed-categories.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

interface SeedCategory {
  name: string;
  // Stable identifier line-item-category.ts's heuristics resolve against
  // -- see Category.key's schema comment. Fixed here, independent of
  // `name` (which a later /catalog/categories rename can freely change).
  key: string;
  parent?: string;
  isLumpSum?: boolean;
  isShowService?: boolean;
}

// Order matches the old CANONICAL_CATEGORIES array exactly.
const SEED_CATEGORIES: SeedCategory[] = [
  { name: "Custom Build", key: "custom_build" },
  { name: "Structure", key: "structure", parent: "Custom Build" },
  { name: "Flooring", key: "flooring" },
  { name: "Furniture", key: "furniture" },
  { name: "Accessories", key: "accessories" },
  { name: "Audio/Visual", key: "audio_visual" },
  { name: "Graphics", key: "graphics" },
  { name: "Signage", key: "signage" },
  { name: "Professional Services", key: "professional_services", isLumpSum: true },
  { name: "Labor", key: "labor", isLumpSum: true, isShowService: true },
  { name: "Shipping", key: "shipping", isLumpSum: true, isShowService: true },
  { name: "Other", key: "other" },
];

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  // Two passes: create/update every category without parentId first (so
  // every row exists to be referenced), then set parentId in a second
  // pass -- avoids ordering the seed list around parent-before-child.
  const idByName = new Map<string, string>();

  for (const [index, seed] of SEED_CATEGORIES.entries()) {
    const existing = await db.category.findFirst({ where: { name: seed.name } });
    const data = {
      sortOrder: index,
      isLumpSum: seed.isLumpSum ?? false,
      isShowService: seed.isShowService ?? false,
    };
    const row = existing
      ? await db.category.update({ where: { id: existing.id }, data })
      : await db.category.create({ data: { name: seed.name, key: seed.key, ...data } });
    idByName.set(seed.name, row.id);
    console.log(`${existing ? "Updated" : "Created"}: ${seed.name}`);
  }

  for (const seed of SEED_CATEGORIES) {
    if (!seed.parent) continue;
    const id = idByName.get(seed.name)!;
    const parentId = idByName.get(seed.parent)!;
    await db.category.update({ where: { id }, data: { parentId } });
    console.log(`Set parent: ${seed.name} -> ${seed.parent}`);
  }

  await db.$disconnect();
}

main();
