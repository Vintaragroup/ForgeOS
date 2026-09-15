// One-time (re-runnable) fix for the "Product" PostShowCondition value --
// see prisma/schema.prisma's PostShowCondition comment for the full story.
// Confirmed by cross-tabbing the real source workbook (every Discarded row
// is EITHER "Product" or "Damaged", never anything else, and 100% of
// "Product" rows share one specific material) that "Product" was never
// really describing physical condition at all -- it meant "approved for
// disposal, not because it was damaged." That's now its own field
// (ArtworkOrder.postShowDiscardReason), so every live PRODUCT-condition
// row gets moved to condition=OK_TO_REUSE (the honest physical-state
// default, absent evidence of actual damage) + discardReason=
// CLIENT_APPROVED_DISPOSAL. postShowDisposalApprovedBy is left null --
// these rows predate that field, and the sheet never recorded WHO
// approved each one, so there's nothing honest to fill in.
//
// Safety: defaults to a dry run that only prints what would change. Pass
// --apply to write. Re-running is a no-op once done (only ever touches
// rows still at condition=PRODUCT).
//
// Usage:
//   npx tsx scripts/backfill-post-show-product-condition.ts             # dry run
//   npx tsx scripts/backfill-post-show-product-condition.ts --apply      # writes

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  console.log(APPLY ? "Running with --apply: this WILL write to the database." : "Dry run (pass --apply to write).");

  const rows = await db.artworkOrder.findMany({
    where: { deletedAt: null, postShowCondition: "PRODUCT" },
    select: { id: true, jobCode: true, graphicCode: true },
  });

  console.log(`${rows.length} row(s) with postShowCondition = PRODUCT found.`);

  if (APPLY && rows.length > 0) {
    const result = await db.artworkOrder.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: { postShowCondition: "OK_TO_REUSE", postShowDiscardReason: "CLIENT_APPROVED_DISPOSAL" },
    });
    console.log(`Updated ${result.count} row(s): condition -> OK_TO_REUSE, discardReason -> CLIENT_APPROVED_DISPOSAL.`);
  } else if (rows.length > 0) {
    console.log("Would update all of the above the same way. Re-run with --apply to commit.");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
