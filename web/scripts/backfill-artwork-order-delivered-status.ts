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
// intermediate ArtworkTransitions edge. It does NOT go through
// transitionArtworkOrder, though -- that stamps today's date on the event,
// which would be dishonest (these pieces weren't delivered today; the real
// show already happened). Instead it writes the ArtworkOrder update and one
// ArtworkOrderEvent per row directly: fromStatus/toStatus for a real trace,
// action BACKFILL_DELIVERED_AT_SHOW, actorType SYSTEM, and a note
// explaining it's a data correction -- so this shows up honestly in the
// order's history instead of as a silent mutation.
//
// Safety: defaults to a dry run that only prints what would change. Pass
// --apply to write. Re-runnable: a row only needs the status update if it
// isn't already at DELIVERED_AT_SHOW, and only needs the event if it
// doesn't already have one recording a DELIVERED_AT_SHOW transition (so a
// second run against rows this script already touched just fills in
// whichever half, if any, didn't happen last time).
//
// Usage:
//   npx tsx scripts/backfill-artwork-order-delivered-status.ts             # dry run
//   npx tsx scripts/backfill-artwork-order-delivered-status.ts --apply      # writes

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");
const BACKFILL_NOTE =
  "Historical import wrote post-show disposition data directly, without walking the order through the approval/production pipeline. Status corrected to DELIVERED_AT_SHOW to reflect the real-world fact (the piece was delivered at its show) and unblock editing this data. See scripts/backfill-artwork-order-delivered-status.ts.";

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  console.log(APPLY ? "Running with --apply: this WILL write to the database." : "Dry run (pass --apply to write).");

  const rows = await db.artworkOrder.findMany({
    where: { deletedAt: null, postShowStatus: { not: null } },
    select: { id: true, jobCode: true, status: true, postShowStatus: true },
  });

  const existingEvents = await db.artworkOrderEvent.findMany({
    where: { artworkOrderId: { in: rows.map((r) => r.id) }, toStatus: "DELIVERED_AT_SHOW" },
    select: { artworkOrderId: true },
  });
  const alreadyEvented = new Set(existingEvents.map((e) => e.artworkOrderId));

  const targets = rows.filter((r) => r.status !== "DELIVERED_AT_SHOW" || !alreadyEvented.has(r.id));

  console.log(`${targets.length} row(s) needing a status update and/or a backfill event.`);
  for (const row of targets) {
    const needsStatus = row.status !== "DELIVERED_AT_SHOW";
    const needsEvent = !alreadyEvented.has(row.id);
    console.log(
      `  ${row.jobCode}: status ${needsStatus ? `${row.status} -> DELIVERED_AT_SHOW` : "already DELIVERED_AT_SHOW"}` +
        `, event ${needsEvent ? "will be created" : "already exists"}`,
    );
  }

  if (APPLY && targets.length > 0) {
    for (const row of targets) {
      await db.$transaction([
        ...(row.status !== "DELIVERED_AT_SHOW"
          ? [db.artworkOrder.update({ where: { id: row.id }, data: { status: "DELIVERED_AT_SHOW" as const } })]
          : []),
        ...(!alreadyEvented.has(row.id)
          ? [
              db.artworkOrderEvent.create({
                data: {
                  artworkOrderId: row.id,
                  fromStatus: row.status,
                  toStatus: "DELIVERED_AT_SHOW",
                  action: "BACKFILL_DELIVERED_AT_SHOW",
                  note: BACKFILL_NOTE,
                  actorType: "SYSTEM",
                },
              }),
            ]
          : []),
      ]);
    }
    console.log(`Updated ${targets.length} row(s).`);
  } else if (targets.length > 0) {
    console.log("Would update all of the above the same way. Re-run with --apply to commit.");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
