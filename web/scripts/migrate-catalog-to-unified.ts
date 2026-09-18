// Catalog redesign phase 1: builds/syncs the unified numbered catalog
// (catalog_items) from the legacy materials / rental_items tables. All the
// logic lives in src/lib/catalog-migration.ts (unit-tested); this is the
// CLI wrapper.
//
// Safety: defaults to a dry run -- the real migration runs inside one
// transaction that is then rolled back, so the printed plan (including the
// exact catalog numbers) is what --apply would write, not an estimate.
// Re-runnable: see catalog-migration.ts's header for what a re-run does.
//
// Compare the printed checksum between local dev and production after
// applying both -- identical checksums mean identical catalog numbers.
//
// Usage:
//   npx tsx scripts/migrate-catalog-to-unified.ts             # dry run
//   npx tsx scripts/migrate-catalog-to-unified.ts --apply     # writes
//   npx tsx scripts/migrate-catalog-to-unified.ts --verbose   # also list every created item

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { migrateLegacyCatalog, type CatalogMigrationReport } from "../src/lib/catalog-migration";

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

class DryRunRollback extends Error {
  constructor(readonly report: CatalogMigrationReport) {
    super("dry run -- rolling back");
  }
}

async function main() {
  const db = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL!).host;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`${APPLY ? "APPLY -- this WILL write" : "Dry run (pass --apply to write)"} against ${host}\n`);

  let report: CatalogMigrationReport;
  try {
    report = await db.$transaction(
      async (tx) => {
        const r = await migrateLegacyCatalog(tx);
        if (!APPLY) throw new DryRunRollback(r);
        return r;
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
  } catch (err) {
    if (err instanceof DryRunRollback) report = err.report;
    else throw err;
  }

  const bySource = (s: "material" | "rental") => report.created.filter((c) => c.source === s).length;
  console.log(`Created:   ${report.created.length} (${bySource("material")} from materials, ${bySource("rental")} from rentals)`);
  console.log(`Updated:   ${report.updated}`);
  console.log(`Unchanged: ${report.unchanged}`);
  console.log(`Retired:   ${report.retired.length}${report.retired.length ? " -- " + report.retired.join(", ") : ""}`);
  console.log(`Live catalog items: ${report.totalItems}`);
  console.log(`Checksum: ${report.checksum}`);

  if (report.created.length) {
    const prefixes = new Map<string, number>();
    for (const c of report.created) {
      const prefix = c.catalogNumber.slice(0, 5);
      prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
    }
    console.log(`\nNew numbers by prefix: ${[...prefixes].map(([p, n]) => `${p}×${n}`).join("  ")}`);
    const sample = VERBOSE ? report.created : report.created.slice(0, 8);
    for (const c of sample) console.log(`  ${c.catalogNumber}  ${c.name}`);
    if (!VERBOSE && report.created.length > sample.length) console.log(`  … ${report.created.length - sample.length} more (--verbose to list all)`);
  }

  if (report.warnings.length) {
    console.log(`\nWarnings (${report.warnings.length}):`);
    for (const w of report.warnings) console.log(`  - ${w}`);
  }
  if (report.duplicateNames.length) {
    console.log(`\nSame-name items to review (${report.duplicateNames.length}):`);
    for (const d of report.duplicateNames) console.log(`  - "${d.name}": ${d.catalogNumbers.join(", ")}`);
  }
  if (report.bematrixPairs.length) {
    console.log(`\nBeMatrix items that exist as both purchase stock and rental (${report.bematrixPairs.length}):`);
    for (const p of report.bematrixPairs) console.log(`  - ${p.material} / ${p.rental}  ${p.name}`);
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
