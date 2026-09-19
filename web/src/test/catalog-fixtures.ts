// Test helper for creating CatalogItem fixtures -- a real row needs a
// catalog number, type, and an existing CatalogCategory (FK), none of which
// a test about cut-list nesting or price matching cares about. Defaults to
// a MATERIAL in MSC; pass itemType/categoryCode when the test does care.
import type { Prisma } from "@/generated/prisma/client";
import type { CatalogItemType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { allocateCatalogNumber } from "@/lib/catalog-number";

type FixtureData = Omit<Prisma.CatalogItemUncheckedCreateInput, "catalogNumber" | "itemType" | "categoryCode"> & {
  itemType?: CatalogItemType;
  categoryCode?: string;
};

export async function createTestCatalogItem(data: FixtureData) {
  const { itemType = "MATERIAL", categoryCode = "MSC", ...rest } = data;
  await db.catalogCategory.upsert({
    where: { code: categoryCode },
    create: { code: categoryCode, name: categoryCode },
    update: {},
  });
  const catalogNumber = await allocateCatalogNumber(db, itemType, categoryCode);
  return db.catalogItem.create({ data: { ...rest, catalogNumber, itemType, categoryCode } });
}

// Everything createTestCatalogItem can leave behind, in FK-safe order.
// Call after deleting anything that references a catalog item (cut-list
// parts/sheets/remnants, line items once they link to the catalog).
export async function clearTestCatalog() {
  await db.catalogItemTag.deleteMany();
  await db.catalogItemAlias.deleteMany();
  await db.catalogItem.deleteMany();
  await db.catalogTag.deleteMany();
  await db.catalogCategory.deleteMany();
  await db.catalogNumberSequence.deleteMany();
}
