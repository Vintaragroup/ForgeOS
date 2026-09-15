// One-time (re-runnable) fix for imported ArtworkOrder rows that carry
// post-show data (postShowStatus set) but were never advanced to
// ArtworkOrderStatus.DELIVERED_AT_SHOW -- the historical import wrote the
// post-show disposition directly without walking the approval/production
// pipeline that real new orders go through. recordPostShowDisposition (see
// artwork-order-service.ts) requires status === DELIVERED_AT_SHOW before it
// will let anyone correct that data, so every one of these rows is
// currently stuck: reviewable on the Post-Show page, but not editable.
//
// The piece unquestionably WAS delivered at the show -- that's the only way
// it could have post-show data at all -- so this backfill sets status
// straight to DELIVERED_AT_SHOW rather than walking it through every
// intermediate ArtworkTransitions edge with fabricated timestamps/actors.
// Same posture as backfill-post-show-product-condition.ts: a direct field
// correction on historical data, not a real pipeline transition, so no
// ArtworkOrderEvent is written either.
//
// Safety: defaults to a dry run that only prints what would change. Pass
// --apply to write. Re-running is a no-op once done (only ever touches rows
// with postShowStatus set that aren't already at DELIVERED_AT_SHOW).
//
// Usage:
//   npx tsx scripts/backfill-artwork-order-delivered-status.ts             # dry run
//   npx tsx scripts/backfill-artwork-order-delivered-status.ts --apply      # writes

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  console.log(APPLY ? "Running with --apply: this WILL write to the database." : "Dry run (pass --apply to write).");

  const rows = await db.artworkOrder.findMany({
    where: { deletedAt: null, postShowStatus: { not: null }, status: { not: "DELIVERED_AT_SHOW" } },
    select: { id: true, jobCode: true, status: true, postShowStatus: true },
  });

  console.log(`${rows.length} row(s) with postShowStatus set but status != DELIVERED_AT_SHOW found.`);
  for (const row of rows) {
    console.log(`  ${row.jobCode}: ${row.status} -> DELIVERED_AT_SHOW (postShowStatus=${row.postShowStatus})`);
  }

  if (APPLY && rows.length > 0) {
    const result = await db.artworkOrder.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { status: "DELIVERED_AT_SHOW" },
    });
    console.log(`Updated ${result.count} row(s): status -> DELIVERED_AT_SHOW.`);
  } else if (rows.length > 0) {
    console.log("Would update all of the above the same way. Re-run with --apply to commit.");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
