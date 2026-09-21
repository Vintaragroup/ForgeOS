// Reads a Microsoft Lists tracker export and reports what it contains and
// what ForgeOS would do with it. Read-only -- it never touches the
// database, and there is no --apply.
//
// The point is to answer, before anything is written: does every value in
// a real 282-row show map onto something, and what is left over?
//
// Usage:
//   npx tsx scripts/inspect-graphics-tracker.ts "<path to export.csv>"

import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { parseTrackerCsv, stripListSchemaPreamble, summarize } from "../src/lib/graphics-tracker-import";
import { normalizeVendorName } from "../src/lib/graphics-vendors";
import { GRAPHICS_VENDOR_SEEDS } from "../src/lib/graphics-vendors";

function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('Usage: npx tsx scripts/inspect-graphics-tracker.ts "<path to export.csv>"');
    process.exit(1);
  }

  const raw = stripListSchemaPreamble(readFileSync(path, "utf8"));
  // header:false so the 1,087-column ListSchema row and the real header
  // both come back as plain arrays; parseTrackerCsv decides which is which.
  const rows = Papa.parse<string[]>(raw, { header: false, skipEmptyLines: false }).data;
  const parsed = parseTrackerCsv(rows);
  const s = summarize(parsed);

  console.log(`file: ${path}`);
  console.log(`rows: ${s.rows}\n`);

  console.log("by order type:");
  for (const [type, n] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${type}`);
  }

  console.log(`\nproduction halves: ${s.halves} across ${s.rows} rows`);
  const split = parsed.filter((r) => r.halves.length > 1).length;
  console.log(`  rows split across more than one shop: ${split}`);

  console.log("\nshops named, and whether we have them:");
  const known = new Map(GRAPHICS_VENDOR_SEEDS.map((v) => [normalizeVendorName(v.name), v.name]));
  for (const shop of s.distinctShops) {
    const hit = known.get(normalizeVendorName(shop));
    console.log(`  ${hit ? "ok  " : "NEW "} ${shop}${hit && hit !== shop ? `  ->  ${hit}` : ""}`);
  }

  console.log("\ncoverage:");
  console.log(`  in-hand date:        ${s.withInHandDate}/${s.rows}`);
  console.log(`  packed onto a skid:  ${s.withSkid}/${s.rows}`);
  console.log(`  came from storage:   ${s.fromStorage}/${s.rows}`);
  console.log(`  distinct AM/PMs:     ${s.distinctAmPm.length}`);
  console.log(`  distinct clients:    ${s.clientNames.length}`);

  console.log("\nAM/PM emails (these need ForgeOS accounts to link):");
  for (const email of s.distinctAmPm) console.log(`  ${email}`);

  if (s.warnings.length === 0) {
    console.log("\nno unmapped values -- every cell in this export maps onto something.");
  } else {
    console.log(`\n${s.warnings.length} warning(s):`);
    for (const w of s.warnings.slice(0, 40)) console.log(`  row ${w.rowNumber}: ${w.message}`);
    if (s.warnings.length > 40) console.log(`  ... and ${s.warnings.length - 40} more`);
  }

  // A couple of real rows, end to end, so the mapping is visible rather
  // than just counted.
  console.log("\nsample rows:");
  for (const r of [parsed.find((x) => x.halves.length > 1), parsed.find((x) => x.orderType === "EXHIBITOR")]) {
    if (!r) continue;
    console.log(`  row ${r.rowNumber}  ${r.orderType}  seq=${r.sequence ?? "-"}  "${r.title}"`);
    console.log(`     booth ${r.boothRaw ?? "-"} (${r.boothNumber ?? "not on the floor"})  section ${r.sectionLabel ?? "-"}`);
    console.log(`     in hand ${r.inHandDate?.toISOString().slice(0, 10) ?? "-"}  skid ${r.skidCode ?? "-"}  storage ${r.fromStorage}`);
    for (const h of r.halves) console.log(`     half: ${h.kind}${h.shopName ? ` (${h.shopName})` : ""} -> ${h.productionStatus}`);
  }
}

main();
