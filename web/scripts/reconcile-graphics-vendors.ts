// Brings ForgeOS's vendor table in line with Miami Graphics' print-shop
// list, and cleans up what the Orlando import left behind.
//
// Three jobs:
//   1. Merge duplicate vendor rows (RIOt / Riot (ORLANDO) are the same
//      shop entered twice). Artwork orders and tasks are repointed at the
//      survivor -- the one with more work attached -- and the loser is
//      soft-deleted.
//   2. Match Gabriella's shops against what we already have, by
//      normalized name (see graphics-vendors.ts). "Olympus - Orlando" and
//      "Olympus Custom Print (ORLANDO)" are one vendor, not two.
//   3. Create the shops we don't have yet.
//
// Never deletes a vendor that still has work attached, and never merges
// anything it isn't sure about: rows that look like a person's name
// rather than a shop are reported for a human to decide.
//
// Usage:
//   npx tsx scripts/reconcile-graphics-vendors.ts          # dry run
//   npx tsx scripts/reconcile-graphics-vendors.ts --apply

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { GRAPHICS_VENDOR_SEEDS, looksLikeAPerson, normalizeVendorName } from "../src/lib/graphics-vendors";

const APPLY = process.argv.includes("--apply");

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL!).host;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`database: ${host}`);
  console.log(APPLY ? "mode: APPLY (writes)\n" : "mode: dry run -- nothing will be written\n");

  const existing = await db.vendor.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      name: true,
      initials: true,
      _count: { select: { artworkOrders: true, tasks: true } },
    },
    orderBy: { name: "asc" },
  });

  // --- 1. duplicates among what we already have -------------------------
  const byNormalized = new Map<string, typeof existing>();
  for (const v of existing) {
    const key = normalizeVendorName(v.name);
    byNormalized.set(key, [...(byNormalized.get(key) ?? []), v]);
  }

  const merges: { survivor: (typeof existing)[number]; loser: (typeof existing)[number] }[] = [];
  for (const [, group] of byNormalized) {
    if (group.length < 2) continue;
    // The row with the most work attached wins; ties break on more work
    // then on name, so a re-run picks the same survivor.
    const ranked = [...group].sort(
      (a, b) =>
        b._count.artworkOrders - a._count.artworkOrders ||
        b._count.tasks - a._count.tasks ||
        a.name.localeCompare(b.name),
    );
    const [survivor, ...losers] = ranked;
    for (const loser of losers) merges.push({ survivor, loser });
  }

  console.log(`existing vendors: ${existing.length}`);
  if (merges.length === 0) {
    console.log("  no duplicates found");
  } else {
    console.log(`  ${merges.length} duplicate(s) to merge:`);
    for (const { survivor, loser } of merges) {
      console.log(
        `    "${loser.name}" (${loser._count.artworkOrders} orders, ${loser._count.tasks} tasks)` +
          ` -> "${survivor.name}" (${survivor._count.artworkOrders} orders, ${survivor._count.tasks} tasks)`,
      );
    }
  }

  // --- 2 & 3. reconcile against Gabriella's list ------------------------
  const survivingKeys = new Map<string, (typeof existing)[number]>();
  const mergedAway = new Set(merges.map((m) => m.loser.id));
  for (const v of existing) {
    if (mergedAway.has(v.id)) continue;
    survivingKeys.set(normalizeVendorName(v.name), v);
  }

  const matched: { seed: string; existing: string }[] = [];
  const toCreate: typeof GRAPHICS_VENDOR_SEEDS = [];
  for (const seed of GRAPHICS_VENDOR_SEEDS) {
    const hit = survivingKeys.get(normalizeVendorName(seed.name));
    if (hit) matched.push({ seed: seed.name, existing: hit.name });
    else toCreate.push(seed);
  }

  console.log(`\nGabriella's list: ${GRAPHICS_VENDOR_SEEDS.length} shops`);
  console.log(`  already in ForgeOS: ${matched.length}`);
  for (const m of matched) console.log(`    "${m.seed}"  ==  "${m.existing}"`);
  console.log(`  to create: ${toCreate.length}`);
  for (const v of toCreate) console.log(`    ${v.seenInUse ? "*" : " "} ${v.name}`);
  if (toCreate.some((v) => v.seenInUse)) console.log("    (* = used on the Seatrade April 2026 show)");

  // --- rows that need a human ------------------------------------------
  const suspicious = existing.filter((v) => !mergedAway.has(v.id) && looksLikeAPerson(v.name));
  if (suspicious.length > 0) {
    console.log("\nlooks like a person, not a shop -- left alone, decide by hand:");
    for (const v of suspicious) {
      console.log(`    "${v.name}" (${v._count.artworkOrders} orders, ${v._count.tasks} tasks)`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  await db.$transaction(async (tx) => {
    for (const { survivor, loser } of merges) {
      await tx.artworkOrder.updateMany({ where: { vendorId: loser.id }, data: { vendorId: survivor.id } });
      await tx.task.updateMany({ where: { vendorId: loser.id }, data: { vendorId: survivor.id } });
      // initials is unique, so it has to be released before the row is
      // retired or the survivor can never take that code.
      await tx.vendor.update({ where: { id: loser.id }, data: { deletedAt: new Date(), initials: null } });
    }
    for (const seed of toCreate) {
      const initialsTaken = await tx.vendor.findFirst({ where: { initials: seed.initials } });
      await tx.vendor.create({
        // category is free text shown as-is on /catalog/vendors, whose own
        // field placeholder reads "e.g. Furniture rental, Printing" -- so
        // it takes a human-readable word, not a constant.
        data: { name: seed.name, initials: initialsTaken ? null : seed.initials, category: "Printing" },
      });
    }
  });

  const after = await db.vendor.count({ where: { deletedAt: null } });
  console.log(`\napplied. active vendors: ${after}`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
