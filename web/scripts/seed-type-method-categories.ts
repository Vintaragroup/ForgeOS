// Adds the Type x Method leaf categories (Rental / Purchase / Custom
// Fabricated under each of Structure/Flooring/Furniture/Audio-Visual/
// Misc) confirmed directly with the user -- see the plan file for the
// full rationale. Idempotent/re-runnable, same convention as
// seed-categories.ts: matches existing rows by name, only creates what's
// missing, safe to run more than once.
//
// Renames "Rental Structures" back to "Structure" (same "structure" key,
// unchanged -- see line-item-category.ts's own RENTAL_STRUCTURES_
// CATEGORY_KEY comment) since it becomes the Type-level parent now, with
// "Rental" as one of its three Method children instead of being baked
// into the Type's own name. Cascades to every existing LineItem.category
// string still holding the old name, same as catalog/categories/
// actions.ts's own updateCategory rename-cascade -- LineItem.category is
// a plain string matched by name, not an FK, so a rename with no cascade
// silently orphans every row still holding the old name.
//
// Run with: npx tsx scripts/seed-type-method-categories.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { leafCategoryKey, MISC_CATEGORY_KEY, TYPE_KEYS_WITH_METHOD_SPLIT } from "../src/lib/line-item-category";

const METHOD_LABELS = {
  RENTAL: "Rental",
  PURCHASE: "Purchase",
  CUSTOM_BUILD: "Custom Fabricated",
} as const;

// Type key -> its live display name (as seeded/renamed by this script).
// "structure" is renamed from "Rental Structures" back to "Structure"
// (see file header); the rest already carry the right name today.
const TYPE_DISPLAY_NAMES: Record<string, string> = {
  structure: "Structure",
  flooring: "Flooring",
  furniture: "Furniture",
  audio_visual: "Audio/Visual",
  [MISC_CATEGORY_KEY]: "Misc",
};

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  // Step 1: rename "Rental Structures" -> "Structure", cascading to
  // every LineItem still holding the old name.
  const rentalStructures = await db.category.findFirst({ where: { key: "structure" } });
  if (rentalStructures && rentalStructures.name !== "Structure") {
    await db.$transaction([
      db.category.update({ where: { id: rentalStructures.id }, data: { name: "Structure" } }),
      db.lineItem.updateMany({ where: { category: rentalStructures.name }, data: { category: "Structure" } }),
    ]);
    console.log(`Renamed: "${rentalStructures.name}" -> "Structure" (cascaded to line items)`);
  }

  // Step 2: ensure every Type-level parent exists (Misc is the only
  // genuinely new one; the rest already exist under their current name).
  const typeIdByKey = new Map<string, string>();
  for (const [index, typeKey] of TYPE_KEYS_WITH_METHOD_SPLIT.entries()) {
    const name = TYPE_DISPLAY_NAMES[typeKey];
    const existing = await db.category.findFirst({ where: { key: typeKey } });
    const row = existing
      ? existing
      : await db.category.create({ data: { name, key: typeKey, sortOrder: 100 + index } });
    typeIdByKey.set(typeKey, row.id);
    console.log(`${existing ? "Found" : "Created"} Type: ${name} (${typeKey})`);
  }

  // Step 3: create the 15 Method leaves, parented under their Type.
  // Category.name has a global unique constraint (categories_name_key)
  // -- "Rental" alone can't be reused as five different children's
  // names, so each leaf's name is Type-prefixed ("Structure - Rental",
  // "Flooring - Rental", ...). This reads slightly redundant under the
  // PDF's own nested Type-header/Method-subheader rendering, but is a
  // real win in the Line Items tab's flat tab bar (every leaf + non-
  // Method category renders as its own tab, unnested -- five tabs that
  // all just said "Rental" would be indistinguishable).
  let leafSortOrder = 200;
  for (const typeKey of TYPE_KEYS_WITH_METHOD_SPLIT) {
    const parentId = typeIdByKey.get(typeKey)!;
    const typeName = TYPE_DISPLAY_NAMES[typeKey];
    for (const method of ["RENTAL", "PURCHASE", "CUSTOM_BUILD"] as const) {
      const key = leafCategoryKey(typeKey, method);
      const name = `${typeName} - ${METHOD_LABELS[method]}`;
      const existing = await db.category.findFirst({ where: { key } });
      if (existing) {
        if (existing.parentId !== parentId || existing.name !== name) {
          await db.category.update({ where: { id: existing.id }, data: { parentId, name } });
          console.log(`Updated leaf: ${existing.name} -> ${name} (${key})`);
        } else {
          console.log(`Found leaf: ${name} (${key})`);
        }
      } else {
        await db.category.create({ data: { name, key, parentId, sortOrder: leafSortOrder } });
        console.log(`Created leaf: ${name} (${key})`);
      }
      leafSortOrder++;
    }
  }

  await db.$disconnect();
}

main();
