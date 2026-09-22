// Creates next year's occurrence of a show and rolls the previous one's
// graphics into it.
//
// The show page already has a "Roll over clients" action; this is the same
// rolloverShow() behind it, for the case where the target show does not
// exist yet and the dates are known.
//
// What a rolled piece carries: material, quantity, dimensions, finishing,
// vendor, designer, size tier, and -- since the routing fix -- where it was
// printed. What it does NOT carry: dates and production status. Last
// year's in-hand date is meaningless, and a piece that has not been made
// yet is not "O.S received" because last year's was. So rolled pieces
// arrive with no in-hand date, which means the SLA queues stay quiet until
// someone schedules them. That is correct, not a gap.
//
// Usage:
//   npx tsx scripts/roll-show-forward.ts --from "Seatrade Cruise Global 2026" \
//     --to "Seatrade Cruise Global 2027" --start 2027-04-05 --end 2027-04-08
//   ... --apply

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { rolloverShow } from "../src/lib/artwork-hub";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function parseDate(v: string | undefined, label: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`--${label} is not a date I understand: ${v}`);
  return d;
}

async function main() {
  const fromName = flag("from");
  const toName = flag("to");
  const start = parseDate(flag("start"), "start");
  const end = parseDate(flag("end"), "end");
  if (!fromName || !toName) {
    console.error('Usage: --from "<source show>" --to "<target show>" [--start YYYY-MM-DD --end YYYY-MM-DD] [--apply]');
    process.exit(1);
  }

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

  const source = await db.show.findFirst({ where: { name: fromName, deletedAt: null }, select: { id: true, name: true } });
  if (!source) throw new Error(`No show named ${JSON.stringify(fromName)}.`);
  const existingTarget = await db.show.findFirst({ where: { name: toName, deletedAt: null }, select: { id: true } });
  if (!existingTarget && !start) {
    throw new Error(`${JSON.stringify(toName)} doesn't exist yet, so --start (and --end) are required.`);
  }

  const hubPieces = await db.artworkOrder.count({ where: { deletedAt: null, showId: source.id, opportunityId: null } });
  const clientPieces = await db.artworkOrder.count({
    where: { deletedAt: null, opportunity: { showId: source.id, deletedAt: null } },
  });
  // The hub path skips a piece whose graphicCode already exists on the
  // target, so a source with duplicate codes rolls fewer than it holds.
  const distinctCodes = await db.artworkOrder.findMany({
    where: { deletedAt: null, showId: source.id, opportunityId: null },
    select: { graphicCode: true },
  });
  const unique = new Set(distinctCodes.map((p) => p.graphicCode ?? "")).size;

  console.log(`source: ${source.name}`);
  console.log(`  show-level pieces: ${hubPieces} (${unique} distinct graphic codes)`);
  console.log(`  client pieces:     ${clientPieces}`);
  if (hubPieces !== unique) {
    console.log(`  NOTE: ${hubPieces - unique} piece(s) share a graphic code and will be skipped as duplicates.`);
  }
  console.log(`\ntarget: ${toName}${existingTarget ? " (exists)" : " (will be created)"}`);
  if (start || end) {
    console.log(`  dates: ${start?.toISOString().slice(0, 10) ?? "?"} .. ${end?.toISOString().slice(0, 10) ?? "?"}`);
  }
  console.log("\nrolled pieces arrive at INVITED, marked as reusing existing artwork,");
  console.log("with no in-hand date -- they are unscheduled until someone schedules them.");

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  const target =
    existingTarget ??
    (await db.show.create({ data: { name: toName, eventStartDate: start ?? null, eventEndDate: end ?? null } }));
  if (existingTarget && (start || end)) {
    await db.show.update({
      where: { id: target.id },
      data: { ...(start ? { eventStartDate: start } : {}), ...(end ? { eventEndDate: end } : {}) },
    });
  }

  const result = await rolloverShow({ sourceShowId: source.id, targetShowId: target.id }, { type: "SYSTEM" });
  console.log(`\napplied. ${result.piecesCreated} piece(s), ${result.opportunitiesCreated} opportunity(ies) created.`);

  const live = await db.artworkOrder.count({ where: { deletedAt: null, showId: target.id, archivedAt: null } });
  const withRouting = await db.artworkOrder.count({
    where: { deletedAt: null, showId: target.id, routings: { some: {} } },
  });
  console.log(`live pieces on ${toName}: ${live}, of which ${withRouting} carry a routing.`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
