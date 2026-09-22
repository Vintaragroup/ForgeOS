// One-off: repairs ArtworkOrder.vendorId where a VENDOR routing exists but
// the column was never set.
//
// setArtworkRouting keeps the two in step, and assignVendor goes through
// it -- but scripts/import-graphics-tracker.ts wrote routing rows straight
// to the database and skipped that, leaving 108 Seatrade pieces with a
// shop on their routing and nothing in vendorId. The importer no longer
// does this; these are the rows it already created.
//
// vendorId means "the first outside shop", matching what setArtworkRouting
// writes for a split piece.
//
// Usage:
//   npx tsx scripts/backfill-routing-vendor-id.ts
//   npx tsx scripts/backfill-routing-vendor-id.ts --apply

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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

  const drifted = await db.artworkOrder.findMany({
    where: { deletedAt: null, vendorId: null, routings: { some: { kind: "VENDOR", vendorId: { not: null } } } },
    select: {
      id: true,
      jobCode: true,
      routings: {
        where: { kind: "VENDOR", vendorId: { not: null } },
        orderBy: { createdAt: "asc" },
        select: { vendorId: true, vendor: { select: { name: true } } },
      },
    },
  });

  console.log(`pieces with a routed shop but no vendorId: ${drifted.length}`);
  const byVendor = new Map<string, number>();
  for (const o of drifted) {
    const name = o.routings[0]?.vendor?.name ?? "(unknown)";
    byVendor.set(name, (byVendor.get(name) ?? 0) + 1);
  }
  for (const [name, n] of [...byVendor.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${name}`);
  }

  // The reverse case would mean a vendorId with no routing to match, which
  // rollover used to create. Reported so a run says whether it exists.
  const reverse = await db.artworkOrder.count({
    where: { deletedAt: null, vendorId: { not: null }, routings: { none: { kind: "VENDOR" } } },
  });
  console.log(`\npieces with a vendorId but no VENDOR routing: ${reverse}`);

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  let fixed = 0;
  for (const o of drifted) {
    const vendorId = o.routings[0]?.vendorId;
    if (!vendorId) continue;
    await db.artworkOrder.update({ where: { id: o.id }, data: { vendorId } });
    fixed += 1;
  }
  console.log(`\napplied. ${fixed} piece(s) repaired.`);

  const left = await db.artworkOrder.count({
    where: { deletedAt: null, vendorId: null, routings: { some: { kind: "VENDOR", vendorId: { not: null } } } },
  });
  console.log(`still drifted (should be 0): ${left}`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
