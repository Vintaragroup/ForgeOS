// Copies catalog-style reference data (the unified catalog -- offices,
// catalog categories, items, tags, aliases -- plus Labor Rates, Tax Rates,
// Categories, Vendors, Proposal Templates) from one database
// to another, matching each model's own natural key so it's safe to
// re-run -- an existing row gets its fields updated, not duplicated.
//
// This replaces the one-off copy scripts written by hand across a single
// session (catalog backfill, one ProposalTemplate, a storage-object
// restore) with a single reusable tool for the same recurring problem:
// local dev and Render Postgres are two separate databases by design
// (see README's Deployment section), so reference data created locally
// never appears in production on its own the way code does via git push.
//
// Deliberately NOT wired into any deploy pipeline or given a --source-is-
// prod convenience default -- this always requires both URLs spelled out
// explicitly, and defaults to a dry run. The two DBs it's meant to be
// pointed at (local dev, and a shared production database with real
// business data) are different enough in stakes that a silent implicit
// direction is the wrong default.
//
// Usage:
//   SOURCE_DATABASE_URL="postgresql://localhost/forgeos_dev" \
//   TARGET_DATABASE_URL="<render-url>" \
//   npx tsx scripts/sync-reference-data.ts           # dry run, prints a plan
//   ... npx tsx scripts/sync-reference-data.ts --apply   # actually writes

import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { LaborRateType, LaborRateTier } from "../src/generated/prisma/enums";

const APPLY = process.argv.includes("--apply");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const sourceUrl = requireEnv("SOURCE_DATABASE_URL");
const targetUrl = requireEnv("TARGET_DATABASE_URL");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

const source = new PrismaClient({ adapter: new PrismaPg(sourceUrl) });
const target = new PrismaClient({ adapter: new PrismaPg(targetUrl) });

interface Tally {
  model: string;
  created: number;
  updated: number;
  unchanged: number;
}

function printTally(t: Tally) {
  console.log(
    `${t.model.padEnd(18)} created=${t.created}  updated=${t.updated}  unchanged=${t.unchanged}`,
  );
}

async function syncCategories(): Promise<Tally> {
  const tally: Tally = { model: "Category", created: 0, updated: 0, unchanged: 0 };
  const rows = await source.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: "asc" } });

  // Matched by `key`, not `name` -- key is Category's own documented
  // stable identifier specifically because `name` can be freely renamed
  // through /catalog/categories (see the model's own schema comment).
  // Matching by name would treat a plain rename as a brand-new category,
  // creating a duplicate in the target rather than updating the existing
  // one -- confirmed as a real, live case, not a hypothetical: "Custom
  // Build" was renamed to "Custom Build / Rental" locally and never
  // propagated, same key ('custom_build') both places.
  const idByKey = new Map<string, string>();

  // Two passes, same reason scripts/seed-categories.ts uses two passes:
  // every row needs to exist before any parentId can reference it.
  for (const row of rows) {
    const existing = await target.category.findFirst({ where: { key: row.key, deletedAt: null } });
    const data = { name: row.name, sortOrder: row.sortOrder, isLumpSum: row.isLumpSum, isShowService: row.isShowService };
    if (existing) {
      const changed =
        existing.name !== data.name ||
        existing.sortOrder !== data.sortOrder ||
        existing.isLumpSum !== data.isLumpSum ||
        existing.isShowService !== data.isShowService;
      if (changed && APPLY) await target.category.update({ where: { id: existing.id }, data });
      idByKey.set(row.key, existing.id);
      if (changed) tally.updated++;
      else tally.unchanged++;
    } else {
      if (APPLY) {
        const created = await target.category.create({ data: { key: row.key, ...data } });
        idByKey.set(row.key, created.id);
      }
      tally.created++;
    }
  }

  if (APPLY) {
    for (const row of rows) {
      if (!row.parentId) continue;
      const parentKey = rows.find((r) => r.id === row.parentId)?.key;
      const childId = idByKey.get(row.key);
      const parentId = parentKey ? idByKey.get(parentKey) : undefined;
      if (childId && parentId) await target.category.update({ where: { id: childId }, data: { parentId } });
    }
  }

  return tally;
}

async function syncTaxRates(): Promise<Tally> {
  const tally: Tally = { model: "TaxRate", created: 0, updated: 0, unchanged: 0 };
  const rows = await source.taxRate.findMany({ where: { deletedAt: null } });
  for (const row of rows) {
    const existing = await target.taxRate.findFirst({ where: { state: row.state, city: row.city, deletedAt: null } });
    const data = { label: row.label, rate: row.rate, effectiveDate: row.effectiveDate };
    if (existing) {
      const changed = !existing.rate.equals(data.rate) || existing.label !== data.label;
      if (changed && APPLY) await target.taxRate.update({ where: { id: existing.id }, data });
      if (changed) tally.updated++;
      else tally.unchanged++;
    } else {
      if (APPLY) await target.taxRate.create({ data: { state: row.state, city: row.city, ...data } });
      tally.created++;
    }
  }
  return tally;
}

// Unified catalog (catalog redesign): replaces the old per-table
// Material / RentalItem sync. Keyed by catalogNumber -- the catalog's own
// permanent identifier, the same reason syncCategories keys on `key`, not
// `name`: a renamed item is still the same item. A number that exists on
// both sides under different names is updated (treated as a rename) but
// also printed, since it could instead mean both databases minted the
// same number for different items -- worth a human look either way.
async function syncCatalog(): Promise<Tally[]> {
  const offices: Tally = { model: "Office", created: 0, updated: 0, unchanged: 0 };
  for (const row of await source.office.findMany({ where: { deletedAt: null } })) {
    const existing = await target.office.findUnique({ where: { code: row.code } });
    const data = { name: row.name, isStandard: row.isStandard };
    if (!existing) {
      if (APPLY) await target.office.create({ data: { code: row.code, ...data } });
      offices.created++;
    } else if (existing.name !== data.name || existing.isStandard !== data.isStandard) {
      if (APPLY) await target.office.update({ where: { code: row.code }, data });
      offices.updated++;
    } else offices.unchanged++;
  }

  const categories: Tally = { model: "CatalogCategory", created: 0, updated: 0, unchanged: 0 };
  const targetCategoryKeys = new Set((await target.category.findMany({ select: { key: true } })).map((c) => c.key));
  for (const row of await source.catalogCategory.findMany({ where: { deletedAt: null } })) {
    const existing = await target.catalogCategory.findUnique({ where: { code: row.code } });
    const data = {
      name: row.name,
      sortOrder: row.sortOrder,
      // Only link an estimate category the target actually has.
      estimateCategoryKey: row.estimateCategoryKey && targetCategoryKeys.has(row.estimateCategoryKey) ? row.estimateCategoryKey : null,
    };
    if (!existing) {
      if (APPLY) await target.catalogCategory.create({ data: { code: row.code, ...data } });
      categories.created++;
    } else if (
      existing.name !== data.name ||
      existing.sortOrder !== data.sortOrder ||
      existing.estimateCategoryKey !== data.estimateCategoryKey
    ) {
      if (APPLY) await target.catalogCategory.update({ where: { code: row.code }, data });
      categories.updated++;
    } else categories.unchanged++;
  }

  // Sequences before items: the target's counter must never end up BELOW
  // a number it now holds, or its next allocation would collide.
  for (const row of await source.catalogNumberSequence.findMany()) {
    const key = { itemType: row.itemType, categoryCode: row.categoryCode };
    const existing = await target.catalogNumberSequence.findUnique({ where: { itemType_categoryCode: key } });
    if (APPLY && (!existing || existing.lastValue < row.lastValue)) {
      await target.catalogNumberSequence.upsert({
        where: { itemType_categoryCode: key },
        create: { ...key, lastValue: row.lastValue },
        update: { lastValue: row.lastValue },
      });
    }
  }

  const items: Tally = { model: "CatalogItem", created: 0, updated: 0, unchanged: 0 };
  const sourceItems = await source.catalogItem.findMany({
    where: { deletedAt: null },
    include: { tags: { include: { tag: true } }, aliases: true },
  });
  for (const row of sourceItems) {
    const data = {
      itemType: row.itemType,
      categoryCode: row.categoryCode,
      name: row.name,
      description: row.description,
      unit: row.unit,
      unitCost: row.unitCost,
      unitPrice: row.unitPrice,
      sourceNote: row.sourceNote,
      materialType: row.materialType,
      stockWidth: row.stockWidth,
      stockLength: row.stockLength,
      thickness: row.thickness,
      defaultKerf: row.defaultKerf,
      grainDirectionMatters: row.grainDirectionMatters,
    };
    const existing = await target.catalogItem.findUnique({ where: { catalogNumber: row.catalogNumber } });
    let targetId = existing?.id;
    if (!existing) {
      if (APPLY) targetId = (await target.catalogItem.create({ data: { catalogNumber: row.catalogNumber, ...data } })).id;
      items.created++;
    } else {
      const decimalChanged = (a: Prisma.Decimal | null, b: Prisma.Decimal | null) => (a == null || b == null ? a != b : !a.equals(b));
      const changed =
        existing.name !== data.name ||
        existing.categoryCode !== data.categoryCode ||
        existing.unit !== data.unit ||
        existing.description !== data.description ||
        existing.sourceNote !== data.sourceNote ||
        existing.materialType !== data.materialType ||
        decimalChanged(existing.unitCost, data.unitCost) ||
        decimalChanged(existing.unitPrice, data.unitPrice) ||
        decimalChanged(existing.stockWidth, data.stockWidth) ||
        decimalChanged(existing.stockLength, data.stockLength);
      if (existing.name !== data.name) {
        console.log(`  ! ${row.catalogNumber}: "${existing.name}" -> "${data.name}" (rename, or a number minted twice?)`);
      }
      if (changed && APPLY) await target.catalogItem.update({ where: { id: existing.id }, data: { ...data, deletedAt: null } });
      if (changed) items.updated++;
      else items.unchanged++;
    }
    if (!APPLY || !targetId) continue;
    for (const { tag } of row.tags) {
      const targetTag = await target.catalogTag.upsert({ where: { name: tag.name }, create: { name: tag.name }, update: {} });
      await target.catalogItemTag.upsert({
        where: { catalogItemId_tagId: { catalogItemId: targetId, tagId: targetTag.id } },
        create: { catalogItemId: targetId, tagId: targetTag.id },
        update: {},
      });
    }
    for (const alias of row.aliases) {
      await target.catalogItemAlias.upsert({
        where: { catalogItemId_normalizedAlias: { catalogItemId: targetId, normalizedAlias: alias.normalizedAlias } },
        create: {
          catalogItemId: targetId,
          alias: alias.alias,
          normalizedAlias: alias.normalizedAlias,
          officeCode: alias.officeCode,
          source: alias.source,
        },
        update: { alias: alias.alias, officeCode: alias.officeCode, source: alias.source },
      });
    }
  }

  return [offices, categories, items];
}

async function syncVendors(): Promise<Tally> {
  const tally: Tally = { model: "Vendor", created: 0, updated: 0, unchanged: 0 };
  const rows = await source.vendor.findMany({ where: { deletedAt: null } });
  for (const row of rows) {
    const existing = await target.vendor.findFirst({ where: { name: row.name, deletedAt: null } });
    const data = { contactInfo: row.contactInfo, category: row.category };
    if (existing) {
      const changed = existing.contactInfo !== data.contactInfo || existing.category !== data.category;
      if (changed && APPLY) await target.vendor.update({ where: { id: existing.id }, data });
      if (changed) tally.updated++;
      else tally.unchanged++;
    } else {
      if (APPLY) await target.vendor.create({ data: { name: row.name, ...data } });
      tally.created++;
    }
  }
  return tally;
}

async function syncProposalTemplates(): Promise<Tally> {
  const tally: Tally = { model: "ProposalTemplate", created: 0, updated: 0, unchanged: 0 };
  const rows = await source.proposalTemplate.findMany({ where: { deletedAt: null } });
  for (const row of rows) {
    const existing = await target.proposalTemplate.findFirst({ where: { name: row.name, deletedAt: null } });
    const data = {
      brandingConfig: row.brandingConfig as Prisma.InputJsonValue,
      layoutConfig: row.layoutConfig as Prisma.InputJsonValue,
    };
    if (existing) {
      const changed = JSON.stringify(existing.brandingConfig) !== JSON.stringify(data.brandingConfig) ||
        JSON.stringify(existing.layoutConfig) !== JSON.stringify(data.layoutConfig);
      if (changed && APPLY) await target.proposalTemplate.update({ where: { id: existing.id }, data });
      if (changed) tally.updated++;
      else tally.unchanged++;
    } else {
      if (APPLY) await target.proposalTemplate.create({ data: { name: row.name, ...data } });
      tally.created++;
    }
  }
  return tally;
}

// LaborRate has no single unique natural key in the schema -- DEPARTMENT
// rows are keyed by departmentCode, CITY_MARKET rows by (city, laborTier),
// the same split prisma/seed.ts and scripts/seed-labor-rates-show-site.ts
// already use for their own fixed id conventions (dept-${code},
// city-${city}), just matched by field values here instead of by a
// specific hardcoded id so it works for whatever the source DB actually
// has, not only the original seed list.
async function syncLaborRates(): Promise<Tally> {
  const tally: Tally = { model: "LaborRate", created: 0, updated: 0, unchanged: 0 };
  const rows = await source.laborRate.findMany({ where: { deletedAt: null } });
  for (const row of rows) {
    const matchWhere =
      row.rateType === ("DEPARTMENT" as LaborRateType)
        ? { rateType: row.rateType, departmentCode: row.departmentCode, deletedAt: null }
        : { rateType: row.rateType, city: row.city, laborTier: row.laborTier as LaborRateTier | null, deletedAt: null };
    const existing = await target.laborRate.findFirst({ where: matchWhere });
    const data = {
      departmentName: row.departmentName,
      unionStatus: row.unionStatus,
      notes: row.notes,
      rate: row.rate,
      effectiveDate: row.effectiveDate,
    };
    if (existing) {
      const changed = !existing.rate.equals(data.rate);
      if (changed && APPLY) await target.laborRate.update({ where: { id: existing.id }, data });
      if (changed) tally.updated++;
      else tally.unchanged++;
    } else {
      if (APPLY) {
        await target.laborRate.create({
          data: {
            rateType: row.rateType,
            departmentCode: row.departmentCode,
            city: row.city,
            laborTier: row.laborTier,
            ...data,
          },
        });
      }
      tally.created++;
    }
  }
  return tally;
}

async function main() {
  console.log(`Source: ${hostOf(sourceUrl)}`);
  console.log(`Target: ${hostOf(targetUrl)}`);
  console.log(APPLY ? "Mode:   APPLY (writing changes)\n" : "Mode:   DRY RUN (pass --apply to write)\n");

  const tallies = [
    await syncCategories(),
    await syncTaxRates(),
    ...(await syncCatalog()),
    await syncVendors(),
    await syncProposalTemplates(),
    await syncLaborRates(),
  ];

  console.log();
  for (const t of tallies) printTally(t);

  await source.$disconnect();
  await target.$disconnect();
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
