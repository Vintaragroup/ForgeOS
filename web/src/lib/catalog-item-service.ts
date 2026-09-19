// The unified catalog's write + search layer (catalog redesign phase 1).
// Every write to CatalogItem goes through here -- the /catalog/items
// Server Actions are thin auth-gate wrappers, same split as
// artwork-order-service.ts / its actions.
//
// Two invariants live here rather than in the UI:
// - catalogNumber is assigned exactly once, in createCatalogItem, and no
//   update path accepts it (see catalog-number.ts for why numbers are
//   permanent).
// - itemType is fixed at creation too -- it's the R-/M-/S- prefix of the
//   number, so changing it later would make the number lie about what the
//   item is. Recategorizing (FUR -> ACC) is allowed and keeps the number,
//   per the agreed numbering rules.

import type { Prisma } from "@/generated/prisma/client";
import type { CatalogItemType, MaterialType } from "@/generated/prisma/enums";
import { db } from "@/lib/db";
import { allocateCatalogNumber, parseCatalogNumber } from "@/lib/catalog-number";
import { significantTokens } from "@/lib/catalog-match-service";
import { UserError } from "@/lib/user-error";

export const CATALOG_ITEM_TYPES: readonly CatalogItemType[] = ["RENTAL", "MATERIAL", "SERVICE"];

export interface CatalogItemFields {
  categoryCode: string;
  name: string;
  description?: string | null;
  unit?: string | null;
  unitCost?: number | null;
  unitPrice?: number | null;
  sourceNote?: string | null;
  materialType?: MaterialType | null;
  stockWidth?: number | null;
  stockLength?: number | null;
  thickness?: number | null;
  defaultKerf?: number | null;
  grainDirectionMatters?: boolean;
  // Replaces the item's whole tag set; free text, normalized to slugs.
  tags?: string[];
}

// "FR Rated" / "fr-rated " / "FR_RATED" all become "fr-rated".
export function normalizeTagName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function validateFields(fields: CatalogItemFields, itemType: CatalogItemType) {
  if (!fields.name.trim()) throw new UserError("Name is required.");
  const category = await db.catalogCategory.findFirst({ where: { code: fields.categoryCode, deletedAt: null } });
  if (!category) throw new UserError("Pick a category.");
  for (const [label, value] of [
    ["Our cost", fields.unitCost],
    ["Sell / rental price", fields.unitPrice],
  ] as const) {
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      throw new UserError(`${label} must be a non-negative number.`);
    }
  }
  if (fields.unitCost == null && fields.unitPrice == null) {
    throw new UserError(
      itemType === "MATERIAL"
        ? "Enter what this material costs us (or a sell price)."
        : "Enter a sell / rental price (or what it costs us).",
    );
  }
  if (fields.materialType && itemType !== "MATERIAL") {
    throw new UserError("Cut-list stock setup only applies to materials.");
  }
}

function dataFrom(fields: CatalogItemFields) {
  return {
    categoryCode: fields.categoryCode,
    name: fields.name.trim(),
    description: fields.description?.trim() || null,
    unit: fields.unit?.trim() || null,
    unitCost: fields.unitCost ?? null,
    unitPrice: fields.unitPrice ?? null,
    sourceNote: fields.sourceNote?.trim() || null,
    materialType: fields.materialType ?? null,
    stockWidth: fields.stockWidth ?? null,
    stockLength: fields.stockLength ?? null,
    thickness: fields.thickness ?? null,
    defaultKerf: fields.defaultKerf ?? null,
    grainDirectionMatters: fields.grainDirectionMatters ?? false,
  };
}

async function replaceTags(tx: Prisma.TransactionClient, catalogItemId: string, rawTags: string[]) {
  const names = [...new Set(rawTags.map(normalizeTagName).filter(Boolean))];
  await tx.catalogItemTag.deleteMany({ where: { catalogItemId } });
  for (const name of names) {
    const tag = await tx.catalogTag.upsert({ where: { name }, create: { name }, update: {} });
    await tx.catalogItemTag.create({ data: { catalogItemId, tagId: tag.id } });
  }
}

export async function createCatalogItem(itemType: CatalogItemType, fields: CatalogItemFields) {
  if (!CATALOG_ITEM_TYPES.includes(itemType)) throw new UserError("Pick an item type.");
  await validateFields(fields, itemType);
  return db.$transaction(async (tx) => {
    const catalogNumber = await allocateCatalogNumber(tx, itemType, fields.categoryCode);
    const item = await tx.catalogItem.create({ data: { catalogNumber, itemType, ...dataFrom(fields) } });
    if (fields.tags) await replaceTags(tx, item.id, fields.tags);
    return item;
  });
}

export async function updateCatalogItem(id: string, fields: CatalogItemFields) {
  const existing = await db.catalogItem.findFirst({ where: { id, deletedAt: null } });
  if (!existing) throw new UserError("That catalog item no longer exists.");
  await validateFields(fields, existing.itemType);
  return db.$transaction(async (tx) => {
    const item = await tx.catalogItem.update({ where: { id }, data: dataFrom(fields) });
    if (fields.tags) await replaceTags(tx, id, fields.tags);
    return item;
  });
}

// Soft delete -- the number stays reserved forever (CatalogNumberSequence
// only moves forward), and anything already pointing at the item (cut-list
// parts today, estimate line items in phase 2) keeps a valid reference.
export async function retireCatalogItem(id: string) {
  await db.catalogItem.update({ where: { id }, data: { deletedAt: new Date() } });
}

export async function addCatalogItemAlias(
  catalogItemId: string,
  input: { alias: string; officeCode?: string | null; source?: string | null },
) {
  const alias = input.alias.trim();
  if (!alias) throw new UserError("Enter the other name this item goes by.");
  const normalizedAlias = significantTokens(alias).join(" ");
  if (!normalizedAlias) throw new UserError("That alias has no searchable words in it.");
  const item = await db.catalogItem.findUniqueOrThrow({ where: { id: catalogItemId }, select: { name: true } });
  if (significantTokens(item.name).join(" ") === normalizedAlias) {
    throw new UserError("That's already this item's own name.");
  }
  const duplicate = await db.catalogItemAlias.findUnique({
    where: { catalogItemId_normalizedAlias: { catalogItemId, normalizedAlias } },
  });
  if (duplicate) throw new UserError(`"${duplicate.alias}" is already an alias for this item.`);
  return db.catalogItemAlias.create({
    data: {
      catalogItemId,
      alias,
      normalizedAlias,
      officeCode: input.officeCode || null,
      source: input.source?.trim() || null,
    },
  });
}

export async function removeCatalogItemAlias(catalogItemId: string, aliasId: string) {
  // Scoped by catalogItemId so an alias id from a form can't delete
  // another item's alias.
  await db.catalogItemAlias.deleteMany({ where: { id: aliasId, catalogItemId } });
}

export interface CatalogSearch {
  q?: string;
  itemType?: CatalogItemType;
  categoryCode?: string;
  tag?: string;
}

// One search for the /catalog/items list and (phase 2) the estimate
// line-item picker. `q` matches a catalog number (exact if it parses as
// one, otherwise as a prefix like "R-FUR"), the name, any alias, or a tag
// -- case-insensitive substring, which is what someone typing into a
// search box expects; the stricter all-words matcher in
// catalog-match-service.ts is for unattended auto-suggestion, not this.
export function catalogSearchWhere(search: CatalogSearch): Prisma.CatalogItemWhereInput {
  const where: Prisma.CatalogItemWhereInput = { deletedAt: null };
  if (search.itemType) where.itemType = search.itemType;
  if (search.categoryCode) where.categoryCode = search.categoryCode;
  if (search.tag) where.tags = { some: { tag: { name: normalizeTagName(search.tag) } } };

  const q = search.q?.trim();
  if (q) {
    const parsed = parseCatalogNumber(q);
    // A query with no letters/digits ("$", "--") normalizes to an empty tag
    // name, which `contains` would match against EVERY tag -- skip it.
    const tagQuery = normalizeTagName(q);
    where.OR = parsed
      ? [{ catalogNumber: q.toUpperCase() }]
      : [
          { catalogNumber: { startsWith: q.toUpperCase() } },
          { name: { contains: q, mode: "insensitive" } },
          { aliases: { some: { alias: { contains: q, mode: "insensitive" } } } },
          ...(tagQuery ? [{ tags: { some: { tag: { name: { contains: tagQuery } } } } }] : []),
        ];
  }
  return where;
}

export async function searchCatalogItems(search: CatalogSearch, take?: number) {
  return db.catalogItem.findMany({
    where: catalogSearchWhere(search),
    include: { category: true, tags: { include: { tag: true } }, _count: { select: { aliases: true } } },
    orderBy: [{ catalogNumber: "asc" }],
    take,
  });
}
