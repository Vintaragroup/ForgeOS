// Runs one Salesmate -> ForgeOS sync from the command line -- the same
// runSalesmateSync the daily cron and the admin "Sync now" button use, so
// it records a SalesmateSyncRun like they do. For the first sync against a
// database, and for checking the connection from a terminal.
//
// Unlike the backfill scripts there's no dry run: the sync only ever
// mirrors Salesmate data and auto-links exact name matches (see
// salesmate-sync.ts), and a re-run is always safe. Point DATABASE_URL at
// the database you mean.
//
// Usage:
//   npx tsx scripts/sync-salesmate.ts

import "dotenv/config";
import { runSalesmateSync, type SalesmateSyncStats } from "../src/lib/salesmate-sync";
import { db } from "../src/lib/db";

async function main() {
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL!).host;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`Syncing Salesmate -> ${host} …`);
  const run = await runSalesmateSync({ trigger: "SCRIPT" });
  const stats = run.stats as unknown as SalesmateSyncStats | null;
  console.log(`Status: ${run.status}${run.error ? ` -- ${run.error}` : ""}`);
  if (stats) {
    console.log("Companies:", stats.companies);
    console.log("Contacts: ", stats.contacts);
    console.log("Deals:    ", stats.deals);
    if (stats.warnings.length) console.log(`Warnings (${stats.warnings.length}):\n  - ${stats.warnings.join("\n  - ")}`);
  }
  await db.$disconnect();
  if (run.status !== "SUCCEEDED") process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
