// Catalog redesign phase 1: builds the unified, numbered catalog
// (CatalogItem) from the legacy Material / RentalItem tables. Run via
// scripts/migrate-catalog-to-unified.ts; kept here as a plain function
// taking an explicit client so it's unit-testable against forgeos_test.
//
// Until the app is cut over to CatalogItem (phase 1, push 2), the legacy
// tables are still what users edit -- so this is a SYNC, not a one-shot
// copy: every run creates items for new legacy rows, refreshes fields on
// already-migrated ones, and retires items whose legacy row was deleted.
// The one thing a re-run never touches is an existing catalogNumber.
//
// Numbering order is deterministic -- within each (type, category), by
// name (case-insensitive), then price, then legacy id as a last resort --
// so local dev and production, which hold the same catalog rows, mint
// identical numbers. The report's checksum is how to confirm that.

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { CatalogItemType, MaterialType } from "@/generated/prisma/enums";
import { allocateCatalogNumber } from "@/lib/catalog-number";
import { significantTokens } from "@/lib/catalog-match-service";

type Client = PrismaClient | Prisma.TransactionClient;

export const OFFICES = [
  { code: "ORL", name: "Orlando", isStandard: true },
  { code: "MIA", name: "Miami", isStandard: false },
  { code: "LAX", name: "Los Angeles", isStandard: false },
] as const;

// estimateCategoryKey is a Category.key from seed-type-method-categories /
// seed-categories -- only linked where the mapping is unambiguous. Raw
// stock (sheet goods, lumber, hardware...) can end up in any custom build,
// so it stays null and line-item-category.ts keeps deciding per line.
export const CATALOG_CATEGORIES: {
  code: string;
  name: string;
  estimateCategoryKey: string | null;
}[] = [
  // Rentals
  { code: "FUR", name: "Furniture", estimateCategoryKey: "furniture" },
  { code: "STR", name: "Structure", estimateCategoryKey: "structure" },
  { code: "BMX", name: "BeMatrix System", estimateCategoryKey: "structure" },
  { code: "ACC", name: "Accessories", estimateCategoryKey: "accessories" },
  { code: "AVL", name: "Audio/Visual", estimateCategoryKey: "audio_visual" },
  { code: "FLR", name: "Flooring", estimateCategoryKey: "flooring" },
  { code: "HGS", name: "Hanging Sign", estimateCategoryKey: "signage" },
  { code: "GRP", name: "Graphics Package", estimateCategoryKey: "graphics" },
  // Materials
  { code: "WSG", name: "Wood & Sheet Goods", estimateCategoryKey: null },
  { code: "LUM", name: "Dimensioned Lumber", estimateCategoryKey: null },
  { code: "SUB", name: "Printing Substrates", estimateCategoryKey: "graphics" },
  { code: "ACR", name: "Acrylic", estimateCategoryKey: null },
  { code: "HDW", name: "Hardware & Fasteners", estimateCategoryKey: null },
  { code: "MIL", name: "Custom Fabrication & Millwork", estimateCategoryKey: null },
  { code: "MTL", name: "Metal & Extrusion", estimateCategoryKey: null },
  { code: "LAM", name: "Laminate & Finishes", estimateCategoryKey: null },
  { code: "PCK", name: "Packing & Crating", estimateCategoryKey: "shipping" },
  { code: "ELE", name: "Electrical", estimateCategoryKey: null },
  { code: "MSC", name: "Miscellaneous", estimateCategoryKey: "misc" },
  // Services
  { code: "DSN", name: "Design Time", estimateCategoryKey: "professional_services" },
  { code: "SHP", name: "Shipping", estimateCategoryKey: "shipping" },
  { code: "LAB", name: "Labor", estimateCategoryKey: "labor" },
];

export const STANDARD_RATE_TAG = "standard-rate";

interface LegacyMapping {
  itemType: CatalogItemType;
  categoryCode: string;
  tags: string[];
}

const MATERIAL_CATEGORY_CODES: Record<string, string> = {
  "wood & sheet goods": "WSG",
  "bematrix system": "BMX",
  "printing substrates": "SUB",
  acrylic: "ACR",
  "dimensioned lumber": "LUM",
  "hardware & fasteners": "HDW",
  "custom fabrication & millwork": "MIL",
  "metal & extrusion": "MTL",
  "laminate & finishes": "LAM",
  "packing & crating": "PCK",
  electrical: "ELE",
  miscellaneous: "MSC",
};

// "(Standard Rate)" rental categories were a second, parallel category
// per type (Standard Cost Sheet's generic per-size reference rates) --
// folded into the real category plus a tag, so there's one Furniture.
const RENTAL_CATEGORY_MAPPINGS: Record<string, Omit<LegacyMapping, "tags"> & { tags?: string[] }> = {
  furniture: { itemType: "RENTAL", categoryCode: "FUR" },
  "furniture (standard rate)": { itemType: "RENTAL", categoryCode: "FUR", tags: [STANDARD_RATE_TAG] },
  "bematrix system": { itemType: "RENTAL", categoryCode: "BMX" },
  accessories: { itemType: "RENTAL", categoryCode: "ACC" },
  "hanging sign": { itemType: "RENTAL", categoryCode: "HGS" },
  structure: { itemType: "RENTAL", categoryCode: "STR" },
  "a/v": { itemType: "RENTAL", categoryCode: "AVL" },
  "a/v (standard rate)": { itemType: "RENTAL", categoryCode: "AVL", tags: [STANDARD_RATE_TAG] },
  flooring: { itemType: "RENTAL", categoryCode: "FLR" },
  "graphics package": { itemType: "RENTAL", categoryCode: "GRP" },
  "design time": { itemType: "SERVICE", categoryCode: "DSN" },
  shipping: { itemType: "SERVICE", categoryCode: "SHP" },
  labor: { itemType: "SERVICE", categoryCode: "LAB" },
};

// Unknown/blank categories fall back to MSC rather than failing the run --
// reported as warnings so a human decides where they really belong.
export function mapMaterialCategory(category: string | null): LegacyMapping & { unmapped: boolean } {
  const code = category ? MATERIAL_CATEGORY_CODES[category.trim().toLowerCase()] : undefined;
  return { itemType: "MATERIAL", categoryCode: code ?? "MSC", tags: [], unmapped: !code };
}

export function mapRentalCategory(category: string | null): LegacyMapping & { unmapped: boolean } {
  const mapping = category ? RENTAL_CATEGORY_MAPPINGS[category.trim().toLowerCase()] : undefined;
  if (!mapping) return { itemType: "RENTAL", categoryCode: "MSC", tags: [], unmapped: true };
  return { itemType: mapping.itemType, categoryCode: mapping.categoryCode, tags: mapping.tags ?? [], unmapped: false };
}

interface PlannedItem {
  source: "material" | "rental";
  legacyId: string;
  mapping: LegacyMapping;
  name: string;
  sortPrice: number;
  data: {
    name: string;
    unit: string | null;
    unitCost: Prisma.Decimal | null;
    unitPrice: Prisma.Decimal | null;
    sourceNote: string | null;
    materialType: MaterialType | null;
    stockWidth: Prisma.Decimal | null;
    stockLength: Prisma.Decimal | null;
    thickness: Prisma.Decimal | null;
    defaultKerf: Prisma.Decimal | null;
    grainDirectionMatters: boolean;
  };
}

export interface CatalogMigrationReport {
  created: { catalogNumber: string; name: string; source: "material" | "rental" }[];
  updated: number;
  unchanged: number;
  retired: string[];
  warnings: string[];
  // Same-name items within the new catalog (after mapping) -- surfaced for
  // a human to merge or rename, never auto-merged.
  duplicateNames: { name: string; catalogNumbers: string[] }[];
  // BeMatrix rows that exist both as purchase stock (M-BMX) and as a
  // rental (R-BMX) under the same name -- candidates for one item carrying
  // both unitCost and unitPrice. Reported only; pairing is a user decision.
  bematrixPairs: { name: string; material: string; rental: string }[];
  // sha256 over every live "catalogNumber|name" line, sorted -- identical
  // on two databases iff they hold the same numbered catalog.
  checksum: string;
  totalItems: number;
}

function sameDecimal(a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean {
  if (a == null || b == null) return a == b;
  return a.equals(b);
}

function fieldsDiffer(existing: Record<string, unknown>, data: PlannedItem["data"], mapping: LegacyMapping): boolean {
  if (existing.categoryCode !== mapping.categoryCode || existing.itemType !== mapping.itemType) return true;
  for (const [key, value] of Object.entries(data)) {
    const current = existing[key];
    if (value != null && typeof value === "object" && "equals" in value) {
      if (!sameDecimal(current as Prisma.Decimal | null, value as Prisma.Decimal)) return true;
    } else if (current != null && typeof current === "object" && "equals" in current) {
      if (!sameDecimal(current as Prisma.Decimal, value as null)) return true;
    } else if (current !== value) {
      return true;
    }
  }
  return false;
}

export async function migrateLegacyCatalog(client: Client): Promise<CatalogMigrationReport> {
  const report: CatalogMigrationReport = {
    created: [],
    updated: 0,
    unchanged: 0,
    retired: [],
    warnings: [],
    duplicateNames: [],
    bematrixPairs: [],
    checksum: "",
    totalItems: 0,
  };

  // Reference rows first -- idempotent upserts.
  for (const office of OFFICES) {
    await client.office.upsert({
      where: { code: office.code },
      create: office,
      update: { name: office.name, isStandard: office.isStandard },
    });
  }
  const existingCategoryKeys = new Set(
    (await client.category.findMany({ select: { key: true } })).map((c) => c.key),
  );
  for (const [sortOrder, category] of CATALOG_CATEGORIES.entries()) {
    let estimateCategoryKey = category.estimateCategoryKey;
    if (estimateCategoryKey && !existingCategoryKeys.has(estimateCategoryKey)) {
      report.warnings.push(
        `Estimate category "${estimateCategoryKey}" doesn't exist here -- ${category.code} left unlinked.`,
      );
      estimateCategoryKey = null;
    }
    await client.catalogCategory.upsert({
      where: { code: category.code },
      create: { code: category.code, name: category.name, sortOrder, estimateCategoryKey },
      update: { name: category.name, sortOrder, estimateCategoryKey },
    });
  }
  const standardRateTag = await client.catalogTag.upsert({
    where: { name: STANDARD_RATE_TAG },
    create: { name: STANDARD_RATE_TAG },
    update: {},
  });
  const tagIds: Record<string, string> = { [STANDARD_RATE_TAG]: standardRateTag.id };

  const [materials, rentals] = await Promise.all([
    client.material.findMany({ where: { deletedAt: null } }),
    client.rentalItem.findMany({ where: { deletedAt: null } }),
  ]);

  const planned: PlannedItem[] = [];
  for (const m of materials) {
    const mapping = mapMaterialCategory(m.category);
    if (mapping.unmapped) {
      report.warnings.push(`Material "${m.name}" has unmapped category "${m.category ?? "(none)"}" -- filed under MSC.`);
    }
    planned.push({
      source: "material",
      legacyId: m.id,
      mapping,
      name: m.name,
      sortPrice: Number(m.currentUnitCost),
      data: {
        name: m.name,
        unit: m.unit,
        unitCost: m.currentUnitCost,
        unitPrice: null,
        sourceNote: m.sourceNote,
        materialType: m.materialType,
        stockWidth: m.stockWidth,
        stockLength: m.stockLength,
        thickness: m.thickness,
        defaultKerf: m.defaultKerf,
        grainDirectionMatters: m.grainDirectionMatters,
      },
    });
  }
  for (const r of rentals) {
    const mapping = mapRentalCategory(r.category);
    if (mapping.unmapped) {
      report.warnings.push(`Rental "${r.name}" has unmapped category "${r.category ?? "(none)"}" -- filed under MSC.`);
    }
    planned.push({
      source: "rental",
      legacyId: r.id,
      mapping,
      name: r.name,
      sortPrice: Number(r.unitPrice),
      data: {
        name: r.name,
        unit: null,
        unitCost: null,
        unitPrice: r.unitPrice,
        sourceNote: r.priceDerivationNote,
        materialType: null,
        stockWidth: null,
        stockLength: null,
        thickness: null,
        defaultKerf: null,
        grainDirectionMatters: false,
      },
    });
  }

  const typeOrder: Record<CatalogItemType, number> = { RENTAL: 0, MATERIAL: 1, SERVICE: 2 };
  planned.sort(
    (a, b) =>
      typeOrder[a.mapping.itemType] - typeOrder[b.mapping.itemType] ||
      a.mapping.categoryCode.localeCompare(b.mapping.categoryCode) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
      a.sortPrice - b.sortPrice ||
      a.legacyId.localeCompare(b.legacyId),
  );

  const liveMaterialIds = new Set(materials.map((m) => m.id));
  const liveRentalIds = new Set(rentals.map((r) => r.id));

  for (const item of planned) {
    const legacyWhere =
      item.source === "material" ? { legacyMaterialId: item.legacyId } : { legacyRentalItemId: item.legacyId };
    const existing = await client.catalogItem.findUnique({ where: legacyWhere });

    let catalogItemId: string;
    if (!existing) {
      const catalogNumber = await allocateCatalogNumber(client, item.mapping.itemType, item.mapping.categoryCode);
      const createdItem = await client.catalogItem.create({
        data: {
          catalogNumber,
          itemType: item.mapping.itemType,
          categoryCode: item.mapping.categoryCode,
          ...item.data,
          ...legacyWhere,
        },
      });
      catalogItemId = createdItem.id;
      report.created.push({ catalogNumber, name: item.name, source: item.source });
    } else {
      catalogItemId = existing.id;
      if (existing.deletedAt || fieldsDiffer(existing, item.data, item.mapping)) {
        // Number deliberately untouched, even if the category moved.
        await client.catalogItem.update({
          where: { id: existing.id },
          data: { itemType: item.mapping.itemType, categoryCode: item.mapping.categoryCode, ...item.data, deletedAt: null },
        });
        report.updated++;
      } else {
        report.unchanged++;
      }
    }

    for (const tag of item.mapping.tags) {
      await client.catalogItemTag.upsert({
        where: { catalogItemId_tagId: { catalogItemId, tagId: tagIds[tag] } },
        create: { catalogItemId, tagId: tagIds[tag] },
        update: {},
      });
    }
  }

  // Retire items whose legacy row is gone (soft-deleted in the old UI).
  const migrated = await client.catalogItem.findMany({
    where: { deletedAt: null, OR: [{ legacyMaterialId: { not: null } }, { legacyRentalItemId: { not: null } }] },
    select: { id: true, catalogNumber: true, legacyMaterialId: true, legacyRentalItemId: true },
  });
  for (const item of migrated) {
    const gone =
      (item.legacyMaterialId && !liveMaterialIds.has(item.legacyMaterialId)) ||
      (item.legacyRentalItemId && !liveRentalIds.has(item.legacyRentalItemId));
    if (gone) {
      await client.catalogItem.update({ where: { id: item.id }, data: { deletedAt: new Date() } });
      report.retired.push(item.catalogNumber);
    }
  }

  const live = await client.catalogItem.findMany({
    where: { deletedAt: null },
    select: { catalogNumber: true, name: true, categoryCode: true, itemType: true },
    orderBy: { catalogNumber: "asc" },
  });
  report.totalItems = live.length;
  report.checksum = createHash("sha256")
    .update(live.map((i) => `${i.catalogNumber}|${i.name}`).join("\n"))
    .digest("hex");

  const byName = new Map<string, string[]>();
  for (const i of live) {
    const key = i.name.trim().toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), i.catalogNumber]);
  }
  report.duplicateNames = [...byName.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([name, catalogNumbers]) => ({ name, catalogNumbers }));

  const bmxRentalsByTokens = new Map<string, string>();
  for (const i of live) {
    if (i.itemType === "RENTAL" && i.categoryCode === "BMX") {
      bmxRentalsByTokens.set(significantTokens(i.name).join(" "), i.catalogNumber);
    }
  }
  for (const i of live) {
    if (i.itemType !== "MATERIAL" || i.categoryCode !== "BMX") continue;
    const rental = bmxRentalsByTokens.get(significantTokens(i.name).join(" "));
    if (rental) report.bematrixPairs.push({ name: i.name, material: i.catalogNumber, rental });
  }

  return report;
}
