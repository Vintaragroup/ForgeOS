// One-off: untangles the two PGA show rows in production.
//
// The names were misleading. "PGA Show" held the real 2026 occurrence --
// 47 WON opportunities and all 639 artwork orders from the control-log
// import. The row actually NAMED "PGA Show 2026" was a scratch row: one
// real deal (Club Glove, still estimating) plus three opportunities
// literally called "Test client @ PGA Show 2026". No rollover links point
// at either, so nothing depends on the current arrangement.
//
// Dates confirmed by Ryan on 2026-09-21: the 2026 show ran 20-23 January
// 2026; the next occurrence runs 26-29 January 2027.
//
// What this does, in one transaction:
//   1. "PGA Show 2026" -> "PGA Show 2027", dated 26-29 Jan 2027. Keeps the
//      Club Glove opportunity, which becomes a 2027 deal.
//   2. Soft-deletes the three "Test client" opportunities.
//   3. "PGA Show" -> "PGA Show 2026", dated 20-23 Jan 2026.
//
// Step 1 runs before step 3 on purpose: renaming "PGA Show" first would
// collide with the row that still holds that name.
//
// It does NOT archive anything. Run this first, then:
//   npx tsx scripts/archive-past-show-artwork.ts --show "PGA Show 2026" --apply
//
// Usage:
//   npx tsx scripts/resolve-pga-shows.ts           # dry run
//   npx tsx scripts/resolve-pga-shows.ts --apply

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");

const HISTORIC_NAME = "PGA Show";
const SCRATCH_NAME = "PGA Show 2026";
const NEXT_NAME = "PGA Show 2027";

const SHOW_2026 = { start: new Date("2026-01-20T00:00:00Z"), end: new Date("2026-01-23T00:00:00Z") };
const SHOW_2027 = { start: new Date("2027-01-26T00:00:00Z"), end: new Date("2027-01-29T00:00:00Z") };

const TEST_OPPORTUNITY_SHOWNAME = "Test client @ PGA Show 2026";
const TEST_COMPANY_NAME = "Test client";

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

  const historic = await db.show.findFirst({ where: { name: HISTORIC_NAME, deletedAt: null } });
  const scratch = await db.show.findFirst({ where: { name: SCRATCH_NAME, deletedAt: null } });
  if (!historic) throw new Error(`No show named ${JSON.stringify(HISTORIC_NAME)} -- already resolved?`);
  if (!scratch) throw new Error(`No show named ${JSON.stringify(SCRATCH_NAME)} -- already resolved?`);

  // Named precisely so a real client called something similar can't be
  // caught by this.
  const testOpportunities = await db.opportunity.findMany({
    where: {
      showId: scratch.id,
      deletedAt: null,
      showName: TEST_OPPORTUNITY_SHOWNAME,
      company: { name: TEST_COMPANY_NAME },
    },
    select: { id: true, showName: true, company: { select: { name: true } } },
  });

  const keptOnScratch = await db.opportunity.count({
    where: { showId: scratch.id, deletedAt: null, id: { notIn: testOpportunities.map((o) => o.id) } },
  });
  const historicPieces = await db.artworkOrder.count({
    where: { deletedAt: null, OR: [{ showId: historic.id }, { opportunity: { showId: historic.id } }] },
  });

  console.log(`1. "${SCRATCH_NAME}" -> "${NEXT_NAME}"  (${fmt(SHOW_2027)})`);
  console.log(`     keeps ${keptOnScratch} opportunit${keptOnScratch === 1 ? "y" : "ies"}`);
  console.log(`2. soft-delete ${testOpportunities.length} test opportunit${testOpportunities.length === 1 ? "y" : "ies"}`);
  for (const o of testOpportunities) console.log(`     ${o.company.name} -- ${o.showName}`);
  console.log(`3. "${HISTORIC_NAME}" -> "${SCRATCH_NAME}"  (${fmt(SHOW_2026)})`);
  console.log(`     ${historicPieces} artwork piece(s) stay attached, to be archived separately`);

  if (testOpportunities.length !== 3) {
    console.log(`\nNOTE: expected 3 test opportunities, found ${testOpportunities.length}. Check before applying.`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  const deletedAt = new Date();
  await db.$transaction(async (tx) => {
    // Rename the scratch row out of the way first -- the historic row
    // cannot take the name while this one still holds it.
    await tx.show.update({
      where: { id: scratch.id },
      data: { name: NEXT_NAME, eventStartDate: SHOW_2027.start, eventEndDate: SHOW_2027.end },
    });
    if (testOpportunities.length > 0) {
      await tx.opportunity.updateMany({
        where: { id: { in: testOpportunities.map((o) => o.id) } },
        data: { deletedAt },
      });
    }
    await tx.show.update({
      where: { id: historic.id },
      data: { name: SCRATCH_NAME, eventStartDate: SHOW_2026.start, eventEndDate: SHOW_2026.end },
    });
  });

  console.log("\napplied.");
  for (const s of await db.show.findMany({ where: { deletedAt: null }, orderBy: { eventStartDate: "asc" } })) {
    console.log(`  ${s.name}  ${s.eventStartDate?.toISOString().slice(0, 10) ?? "(no date)"} .. ${s.eventEndDate?.toISOString().slice(0, 10) ?? "(no date)"}`);
  }
  console.log(`\nNext: npx tsx scripts/archive-past-show-artwork.ts --show "${SCRATCH_NAME}" --apply`);
  await db.$disconnect();
}

function fmt(range: { start: Date; end: Date }) {
  return `${range.start.toISOString().slice(0, 10)} .. ${range.end.toISOString().slice(0, 10)}`;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
