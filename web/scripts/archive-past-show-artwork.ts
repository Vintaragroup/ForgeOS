// Marks a past show's graphics as history so they stop looking like live
// work. See ArtworkOrder.archivedAt and src/lib/artwork-scope.ts.
//
// Why it's needed: the PGA control-log import put 639 historical pieces
// into production as if they were current jobs -- 370 sitting in
// PACKAGED_READY ("packed, waiting to ship"), plus 25 spread across
// IN_PRODUCTION, RECEIVED_FROM_VENDOR, INSPECTED, PRODUCTION_GO_AHEAD and
// EXPO_PROOF_CHECK. Every one of them was created on the import date.
//
// It does NOT rewrite `status`. What actually happened to each piece is
// the reason the data was imported; archiving changes visibility only.
//
// Re-runnable: already-archived pieces are counted and skipped, so a
// second run reports 0 newly archived rather than moving timestamps.
//
// Usage:
//   npx tsx scripts/archive-past-show-artwork.ts --show "PGA Show"
//   npx tsx scripts/archive-past-show-artwork.ts --show "PGA Show" --apply
//   npx tsx scripts/archive-past-show-artwork.ts --show "PGA Show" --apply \
//       --start 2026-01-20 --end 2026-01-23
//
// --start/--end also set the show's own eventStartDate/eventEndDate, which
// is what lets anything else in the system tell a past occurrence from a
// future one. Without them the show keeps its null dates and only the
// artwork is archived.

import "dotenv/config";
import { PrismaClient, type Prisma } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function parseDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`--${label} is not a date I understand: ${value}`);
  return d;
}

async function main() {
  const showName = flag("show");
  if (!showName) {
    console.error('Usage: npx tsx scripts/archive-past-show-artwork.ts --show "<show name>" [--apply] [--start YYYY-MM-DD] [--end YYYY-MM-DD]');
    process.exit(1);
  }
  const start = parseDate(flag("start"), "start");
  const end = parseDate(flag("end"), "end");

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

  const shows = await db.show.findMany({ where: { name: showName, deletedAt: null }, select: { id: true, name: true, eventStartDate: true } });
  if (shows.length === 0) throw new Error(`No show named ${JSON.stringify(showName)}.`);
  if (shows.length > 1) {
    // Two rows with the same name is the duplicate-occurrence problem, and
    // guessing which one is meant would archive the wrong set.
    throw new Error(`${shows.length} shows are named ${JSON.stringify(showName)}. Resolve the duplicate first, or rename one.`);
  }
  const show = shows[0];

  // A piece belongs to this show either directly (a Hub/common-area piece)
  // or through its opportunity -- both paths, same as the Graphics Hub
  // reads them.
  const where: Prisma.ArtworkOrderWhereInput = {
    deletedAt: null,
    OR: [{ showId: show.id }, { opportunity: { showId: show.id } }],
  };

  const [total, alreadyArchived, byStatus] = await Promise.all([
    db.artworkOrder.count({ where }),
    db.artworkOrder.count({ where: { ...where, archivedAt: { not: null } } }),
    db.artworkOrder.groupBy({ by: ["status"], where: { ...where, archivedAt: null }, _count: { _all: true } }),
  ]);

  console.log(`show: ${show.name} (${show.id})`);
  console.log(`  pieces: ${total}, already archived: ${alreadyArchived}, to archive: ${total - alreadyArchived}`);
  if (byStatus.length > 0) {
    console.log("  by status:");
    for (const row of [...byStatus].sort((a, b) => b._count._all - a._count._all)) {
      console.log(`    ${String(row._count._all).padStart(5)}  ${row.status}`);
    }
  }
  if (start || end) {
    console.log(`  show dates -> ${start?.toISOString().slice(0, 10) ?? "(unchanged)"} .. ${end?.toISOString().slice(0, 10) ?? "(unchanged)"}`);
  } else if (!show.eventStartDate) {
    console.log("  NOTE: this show still has no eventStartDate. Pass --start/--end to set it.");
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  const archivedAt = new Date();
  const result = await db.artworkOrder.updateMany({ where: { ...where, archivedAt: null }, data: { archivedAt } });
  console.log(`\narchived ${result.count} piece(s)`);

  if (start || end) {
    await db.show.update({
      where: { id: show.id },
      data: { ...(start ? { eventStartDate: start } : {}), ...(end ? { eventEndDate: end } : {}) },
    });
    console.log("show dates updated");
  }

  const remaining = await db.artworkOrder.count({ where: { ...where, archivedAt: null } });
  console.log(`unarchived pieces left on this show: ${remaining}`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
