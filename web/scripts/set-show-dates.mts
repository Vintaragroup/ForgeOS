// Sets a show's four logistics dates, which every opportunity on that
// show inherits unless the booth overrides them.
//
// Dry run by default. Pass --apply to write.
//
//   npx tsx scripts/set-show-dates.mts "PGA Show 2027" [--apply]
//
// These are ESTIMATES until the show's exhibitor kit confirms them. That
// matters more than it sounds: the ship date is what the artwork deadline
// and both rush-fee cutoffs are computed from, so a ship date that moves
// moves the dates rush charges are billed against. Re-run this when the
// kit lands and every opportunity on the show follows.
import { db } from "@/lib/db";

const showName = process.argv[2];
const apply = process.argv.includes("--apply");
if (!showName) throw new Error('usage: set-show-dates.mts "<show name>" [--apply]');

// PGA Show 2027 at the OCCC, from the expected exhibitor windows.
//
//   show floor   Wed 27 - Fri 29 January 2027, closing 2:00 pm Friday
//   move-in      target for large booths begins Friday 22 January
//   move-out     begins at close on Friday 29 January, runs through the weekend
//   ship         estimated: Full Swing PGA Orlando, the same show in the
//                same city, ships 2027-01-04, about 18 days ahead of
//                move-in. No confirmed date exists yet, and inventing a
//                different one would only make the estimate less grounded.
const DATES: Record<string, { eventStartDate: Date; eventEndDate: Date; targetMoveIn: Date; targetMoveOut: Date; shipDate: Date }> = {
  "PGA Show 2027": {
    eventStartDate: new Date("2027-01-27"),
    eventEndDate: new Date("2027-01-29"),
    targetMoveIn: new Date("2027-01-22"),
    targetMoveOut: new Date("2027-01-29"),
    shipDate: new Date("2027-01-04"),
  },
};

const dates = DATES[showName];
if (!dates) throw new Error(`No dates recorded for "${showName}". Known: ${Object.keys(DATES).join(", ")}`);

const show = await db.show.findFirstOrThrow({
  where: { name: showName, deletedAt: null },
  select: {
    id: true,
    name: true,
    eventStartDate: true,
    eventEndDate: true,
    targetMoveIn: true,
    targetMoveOut: true,
    shipDate: true,
    opportunities: {
      where: { deletedAt: null },
      select: { id: true, showName: true, eventStartDate: true, targetMoveIn: true, targetMoveOut: true, shipDate: true },
    },
  },
});

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "—");
console.log(`${show.name}  (${show.opportunities.length} opportunities)\n`);
for (const [field, next] of Object.entries(dates)) {
  const current = show[field as keyof typeof dates] as Date | null;
  const same = current !== null && current.toISOString().slice(0, 10) === next.toISOString().slice(0, 10);
  console.log(`  ${same ? "same " : "SET  "}  ${field.padEnd(16)} ${day(current)} -> ${day(next)}`);
}

// An opportunity with its own date keeps it -- inheritance never overwrites.
console.log("\nWhat each opportunity would inherit (its own date always wins):");
for (const o of show.opportunities) {
  const inherits = (Object.keys(dates) as (keyof typeof dates)[])
    .filter((f) => f !== "eventEndDate")
    .filter((f) => (o as Record<string, unknown>)[f] == null);
  console.log(
    `  ${o.id}  own: ship=${day(o.shipDate)} in=${day(o.targetMoveIn)} out=${day(o.targetMoveOut)} open=${day(o.eventStartDate)}` +
      `  inherits: ${inherits.length > 0 ? inherits.join(", ") : "nothing"}`,
  );
}

if (!apply) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

await db.show.update({ where: { id: show.id }, data: dates });
console.log(`\nWrote ${show.name}. Re-run scripts/recompute-timelines.mts to push these through the timelines.`);
process.exit(0);
