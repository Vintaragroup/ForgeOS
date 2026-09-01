// ONE-OFF, run-once script -- NOT a general utility, delete after use.
// Manually restores 3 line items deleted in production before the
// restore feature's widened DELETE snapshot existed, so their own audit
// rows have no sectionId to restore into automatically. Section
// (Flooring & Platforms) was determined by: (1) their own recorded
// category ("Flooring"), and (2) a surviving sibling line item from the
// same source document already sitting in that section -- confirmed with
// the user directly, since the two signals disagreed for one of the
// three (G-Floor).
//
// Mirrors restoreLineItem's exact approach (estimate-service.ts): same
// original line item id, a real RESTORE audit row pointing back at the
// original DELETE row, then a totals recompute -- just done by hand
// since the automatic path refuses a legacy snapshot with no location.
//
// Run with: DATABASE_URL=<production> npx tsx scripts/one-off-restore-flooring-items.ts

import { PrismaClient, Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { computeVersionTotals } from "../src/lib/estimate-service";

const SECTION_ID = "cmtfuib6p007204l1g4xskxdk"; // Flooring & Platforms
const ACTOR_ID = "cmsvby4h900005by34a0x0mve"; // Ryan Morrow -- directed this restore

const ITEMS = [
  {
    deleteLogId: "cmtj2dvjx000204laivb9q896",
    lineItemId: "cmtfuij49007m04l1k1k7u9h0",
    description: "Flooring overall footprint (qty estimated -- verify)",
    qty: "1800",
    unit: "SQFT",
    unitCost: "5.87",
    totalCost: "10566",
    category: "Flooring",
    lineType: "MATERIAL" as const,
    documentId: "cmtftr09b000304jmrui1medd",
  },
  {
    deleteLogId: "cmtj2dsv5000104lalhphfwfh",
    lineItemId: "cmtfuij4c007n04l1lqi71s9w",
    description: "Base flooring material (qty estimated -- verify)",
    qty: "1",
    unit: "LOT",
    unitCost: "0",
    totalCost: "0",
    category: "Flooring",
    lineType: "MATERIAL" as const,
    documentId: "cmtftr09b000304jmrui1medd",
  },
  {
    deleteLogId: "cmtj2790d000304l2qtlahmq2",
    lineItemId: "cmtfuib72007304l1m9papo9d",
    description: "G-Floor",
    qty: "1",
    unit: "EA",
    unitCost: "0",
    totalCost: "0",
    category: "Flooring",
    lineType: "MATERIAL" as const,
    documentId: "cmtftql9g000204jm376kdito",
  },
];

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const section = await db.estimateSection.findUniqueOrThrow({ where: { id: SECTION_ID } });
  console.log(`Target section: "${section.name}" (estimateVersionId ${section.estimateVersionId})`);

  let restoredCount = 0;
  for (const item of ITEMS) {
    const existing = await db.lineItem.findUnique({ where: { id: item.lineItemId } });
    if (existing) {
      console.log(`SKIP (already exists): ${item.description} (${item.lineItemId})`);
      continue;
    }

    const created = await db.lineItem.create({
      data: {
        id: item.lineItemId,
        sectionId: SECTION_ID,
        lineType: item.lineType,
        description: item.description,
        category: item.category,
        qty: new Prisma.Decimal(item.qty),
        unit: item.unit,
        unitCost: new Prisma.Decimal(item.unitCost),
        totalCost: new Prisma.Decimal(item.totalCost),
        isDraft: false,
        documentId: item.documentId,
      },
    });

    await db.lineItemAuditLog.create({
      data: {
        estimateVersionId: section.estimateVersionId,
        lineItemId: created.id,
        description: created.description,
        action: "RESTORE",
        detail: {
          restoredFromAuditLogId: item.deleteLogId,
          note: "Manually restored -- predated the restore feature's widened snapshot. Section (Flooring & Platforms) confirmed with the user directly.",
        },
        actorId: ACTOR_ID,
      },
    });

    console.log(`Restored: ${item.description} -> ${created.id} ($${created.totalCost.toFixed(2)})`);
    restoredCount++;
  }

  if (restoredCount > 0) {
    // The REAL formula (per-category margin overrides, effective-category
    // resolution, etc.) -- not reimplemented here, imported directly from
    // estimate-service.ts so this can't silently drift from what the app
    // itself would compute.
    const [version, categories, overrides] = await Promise.all([
      db.estimateVersion.findUniqueOrThrow({
        where: { id: section.estimateVersionId },
        include: { sections: { where: { optionId: null }, include: { lineItems: true } } },
      }),
      db.category.findMany({ where: { deletedAt: null } }),
      db.categoryMarginOverride.findMany({ where: { estimateVersionId: section.estimateVersionId } }),
    ]);
    const overridesByCategoryId = new Map(overrides.map((o) => [o.categoryId, o.marginPct]));
    const totals = computeVersionTotals(version, categories, overridesByCategoryId);

    await db.estimateVersion.update({ where: { id: section.estimateVersionId }, data: totals });
    console.log(`Recomputed version totals: totalCost=$${totals.totalCost.toFixed(2)}, grandTotal=$${totals.grandTotal.toFixed(2)}`);
  }

  console.log(`Done. Restored ${restoredCount} of ${ITEMS.length}.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
