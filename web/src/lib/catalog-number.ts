// Catalog numbers: TYPE-CAT-#### (e.g. R-FUR-0001, M-WSG-0142, S-DSN-0003).
//
//   TYPE  R = RENTAL, M = MATERIAL, S = SERVICE (CatalogItemType)
//   CAT   CatalogCategory.code -- 3 uppercase letters
//   ####  per-(type, category) sequence, zero-padded to 4, growing past
//         9999 without breaking the format's parse (just a wider number)
//
// A number is an identifier, not a description: it's assigned once and
// never changes -- not when an item is renamed, not when it's moved to a
// different category (so an item recategorized from FUR to ACC keeps its
// R-FUR-… number; that's intentional, the same way a part number doesn't
// change when a catalog is reorganized). Retired items keep their number
// and it's never handed out again -- see CatalogNumberSequence.

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { CatalogItemType } from "@/generated/prisma/enums";

const TYPE_PREFIX: Record<CatalogItemType, string> = {
  RENTAL: "R",
  MATERIAL: "M",
  SERVICE: "S",
};

const CATEGORY_CODE_PATTERN = /^[A-Z]{3}$/;
const CATALOG_NUMBER_PATTERN = /^([RMS])-([A-Z]{3})-(\d{4,})$/;

export function formatCatalogNumber(itemType: CatalogItemType, categoryCode: string, sequence: number): string {
  if (!CATEGORY_CODE_PATTERN.test(categoryCode)) {
    throw new Error(`Catalog category code must be 3 uppercase letters, got "${categoryCode}".`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Catalog sequence must be a positive integer, got ${sequence}.`);
  }
  return `${TYPE_PREFIX[itemType]}-${categoryCode}-${String(sequence).padStart(4, "0")}`;
}

export function parseCatalogNumber(
  catalogNumber: string,
): { itemType: CatalogItemType; categoryCode: string; sequence: number } | null {
  const match = CATALOG_NUMBER_PATTERN.exec(catalogNumber.trim().toUpperCase());
  if (!match) return null;
  const itemType = (Object.keys(TYPE_PREFIX) as CatalogItemType[]).find((t) => TYPE_PREFIX[t] === match[1])!;
  return { itemType, categoryCode: match[2], sequence: Number(match[3]) };
}

// Reserves the next number for (itemType, categoryCode) in one atomic
// upsert -- the row lock on the sequence row serializes concurrent callers,
// so two estimators adding furniture at the same moment can't both get
// R-FUR-0043. Pass the transaction client when creating the item in the
// same transaction, so a failed create also rolls the reservation back
// (a gap-free sequence isn't a requirement, but there's no reason to burn
// numbers on failed writes either).
export async function allocateCatalogNumber(
  client: PrismaClient | Prisma.TransactionClient,
  itemType: CatalogItemType,
  categoryCode: string,
): Promise<string> {
  if (!CATEGORY_CODE_PATTERN.test(categoryCode)) {
    throw new Error(`Catalog category code must be 3 uppercase letters, got "${categoryCode}".`);
  }
  const rows = await client.$queryRaw<{ lastValue: number }[]>`
    INSERT INTO catalog_number_sequences ("itemType", "categoryCode", "lastValue")
    VALUES (${itemType}::"CatalogItemType", ${categoryCode}, 1)
    ON CONFLICT ("itemType", "categoryCode")
    DO UPDATE SET "lastValue" = catalog_number_sequences."lastValue" + 1
    RETURNING "lastValue"
  `;
  return formatCatalogNumber(itemType, categoryCode, rows[0].lastValue);
}
