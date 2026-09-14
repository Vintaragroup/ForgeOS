// One-time (re-runnable) import of the customer list exported from
// Salesmate (Companies list -> CSV) into ForgeOS's Company table.
//
// Salesmate's own "Type" field distinguishes Customer/Lead/Prospect/
// Partner/Marketing Qualified Lead -- this import takes ONLY rows typed
// "Customer" (per the explicit scope: "current customers", not the full
// pipeline of leads/prospects). This also naturally excludes ExpoCCI's own
// company record, which the export includes as a "Partner"-typed row --
// it shouldn't become a Company (client) record representing itself.
//
// Company has no separate street/city/state/zip fields (see
// prisma/schema.prisma) -- the CSV's address columns are composed into
// the single billingAddress free-text field instead. Salesmate's Phone,
// Website, social links, Description, and Tags columns have no home in
// this schema slice and are intentionally dropped, not forced into the
// wrong field -- flagged here rather than silently discarded.
//
// Safety: defaults to a dry run that only prints a plan. Pass --apply to
// write. Re-running is safe -- matches an existing Company by name
// (case-insensitive) and only ever creates, never overwrites a
// billingAddress/industry someone already edited by hand in ForgeOS.
//
// Usage:
//   npx tsx scripts/import-salesmate-companies.ts             # dry run
//   npx tsx scripts/import-salesmate-companies.ts --apply      # writes
//   npx tsx scripts/import-salesmate-companies.ts --apply --file path/to/export.csv

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const APPLY = process.argv.includes("--apply");
const fileFlagIndex = process.argv.indexOf("--file");
const CSV_PATH =
  fileFlagIndex !== -1 && process.argv[fileFlagIndex + 1]
    ? process.argv[fileFlagIndex + 1]
    : path.join(__dirname, "../../data/Sales-mate_customer-list/2f647ee0-b055-11f1-984d-d31d375fb0dc.csv");

const INCLUDED_TYPES = new Set(["customer"]);

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const db = new PrismaClient({ adapter });

interface SalesmateCompanyRow {
  Name: string;
  Type: string;
  "Address Line 1": string;
  "Address Line 2": string;
  City: string;
  ZipCode: string;
  State: string;
  Country: string;
}

function composeBillingAddress(row: SalesmateCompanyRow): string | null {
  const lines = [row["Address Line 1"], row["Address Line 2"]].filter((l) => l && l.trim());
  const cityStateZip = [row.City, row.State, row.ZipCode].filter((v) => v && v.trim()).join(", ");
  if (cityStateZip) lines.push(cityStateZip);
  if (row.Country && row.Country.trim()) lines.push(row.Country.trim());
  return lines.length > 0 ? lines.join("\n") : null;
}

async function main() {
  console.log(APPLY ? "Running with --apply: this WILL write to the database." : "Dry run (pass --apply to write).");
  console.log(`Reading: ${CSV_PATH}\n`);

  const csvText = fs.readFileSync(CSV_PATH, "utf-8");
  const parsed = Papa.parse<SalesmateCompanyRow>(csvText, { header: true, skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    console.error("CSV parse errors:", parsed.errors);
    process.exit(1);
  }
  const rows = parsed.data;
  console.log(`${rows.length} total rows in export.`);

  const customerRows = rows.filter((r) => INCLUDED_TYPES.has((r.Type ?? "").trim().toLowerCase()));
  console.log(`${customerRows.length} rows typed "Customer" (the rest -- Leads/Prospects/Partners/blank -- are skipped).\n`);

  let created = 0;
  let skippedExisting = 0;
  let skippedNoName = 0;
  const seenThisRun = new Set<string>();
  const duplicatesInFile: string[] = [];

  for (const row of customerRows) {
    const name = (row.Name ?? "").trim();
    if (!name) {
      skippedNoName++;
      continue;
    }
    const key = name.toLowerCase();
    if (seenThisRun.has(key)) {
      duplicatesInFile.push(name);
      continue;
    }
    seenThisRun.add(key);

    const existing = await db.company.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
    if (existing) {
      skippedExisting++;
      continue;
    }

    const billingAddress = composeBillingAddress(row);
    console.log(`+ create: ${name}`);
    created++;
    if (APPLY) {
      await db.company.create({ data: { name, billingAddress } });
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Created: ${created}`);
  console.log(`Already existed (skipped): ${skippedExisting}`);
  console.log(`Skipped (no name): ${skippedNoName}`);
  if (duplicatesInFile.length > 0) {
    console.log(`Duplicate names within the export itself (only first occurrence used): ${duplicatesInFile.join(", ")}`);
  }
  if (!APPLY) {
    console.log("\nThis was a dry run -- nothing was written. Re-run with --apply to commit.");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
