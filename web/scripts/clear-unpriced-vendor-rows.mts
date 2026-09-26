// Removes line items that came from a VENDOR_QUOTE document but carry no
// price, so the quote can be re-imported through the priced path.
//
// Dry run by default. Pass --apply to write.
//
//   npx tsx scripts/clear-unpriced-vendor-rows.mts <opportunityId> [--apply]
//
// Why it is needed at all: "Build from all analyzed documents" used to
// route vendor quotes through the scope extractor, which has no price
// field, so two real Fuse Technical Group quotes worth $18,422 imported
// as nineteen rows at $0.00. That is fixed -- but
// commitStandaloneVendorQuoteImport refuses to run against a document
// that already has line items on the version (its AlreadyImportedError
// guard), so the zero-priced rows have to go first or the fix cannot
// take effect.
//
// Deletes ONLY rows that are both sourced from a vendor quote AND priced
// at zero. A vendor row with a real price was not produced by the broken
// path and is left alone.
//
// Goes through deleteLineItem rather than a deleteMany: that writes an
// audit row and a restore snapshot per item, so this is undoable. A bulk
// delete would be faster and would leave nineteen rows with no way back.
import { db } from "@/lib/db";
import { deleteLineItem } from "@/lib/estimate-service";

const opportunityId = process.argv[2];
const apply = process.argv.includes("--apply");
if (!opportunityId) throw new Error("usage: clear-unpriced-vendor-rows.mts <opportunityId> [--apply]");

const vendorDocs = await db.document.findMany({
  where: { opportunityId, documentType: "VENDOR_QUOTE", deletedAt: null },
  select: { id: true, filename: true },
});
if (vendorDocs.length === 0) throw new Error("No vendor-quote documents on this opportunity.");

const filenameById = new Map(vendorDocs.map((d) => [d.id, d.filename]));
const candidates = await db.lineItem.findMany({
  where: { documentId: { in: vendorDocs.map((d) => d.id) } },
  select: {
    id: true,
    description: true,
    totalCost: true,
    documentId: true,
    section: { select: { name: true } },
  },
});

const unpriced = candidates.filter((li) => Number(li.totalCost) === 0);
const priced = candidates.filter((li) => Number(li.totalCost) !== 0);

console.log(`${candidates.length} rows from ${vendorDocs.length} vendor quote(s):`);
console.log(`  ${unpriced.length} at $0.00 -- would be removed`);
console.log(`  ${priced.length} with a real price -- left alone\n`);
for (const li of unpriced) {
  console.log(`  remove  [${li.section.name}] ${li.description.slice(0, 56)}`);
  console.log(`            from ${filenameById.get(li.documentId!) ?? "?"}`);
}
for (const li of priced) {
  console.log(`  keep    $${Number(li.totalCost).toFixed(2)}  ${li.description.slice(0, 56)}`);
}

if (!apply) {
  console.log("\nDry run. Pass --apply to write.");
  process.exit(0);
}

let removed = 0;
for (const li of unpriced) {
  await deleteLineItem(opportunityId, li.id, null);
  removed += 1;
}
console.log(`\nRemoved ${removed} unpriced vendor rows. Each one is restorable from its audit entry.`);

const left = await db.lineItem.count({ where: { documentId: { in: vendorDocs.map((d) => d.id) } } });
console.log(`${left} vendor-quote rows remain. Re-run the build to import these quotes with their real prices.`);
process.exit(0);
