// Replaces a version that was copied by the broken copy with one made by
// the fixed copy.
//
// "Create new version" used to carry three of a section's eighteen
// fields (see 6f461da). The result looks right -- same sections, same
// line items, same totals to the cent -- but the booth grouping, the
// build types, every piece of written copy and the deliberate
// show-this/hide-this decisions are all gone.
//
// Backfilling those in place would mean pairing each new section with
// the one it came from, and there is nothing reliable to pair on: name
// and sortOrder repeat across a real estimate, and creation order does
// not survive the copy (on ABC Chicago, 52 of 54 sections paired
// wrongly by index). So this does not guess. It deletes the bad copy and
// runs the fixed copy again from the same locked source, which is exact
// by construction.
//
// That is only safe while the new version is untouched, so it refuses
// unless it is: unlocked, unedited, and referenced by nothing. If
// someone has started re-costing in it, their work is real and this is
// the wrong tool -- it says so and stops.
//
//   npx tsx scripts/recopy-version-from-locked.ts <badVersionId>
//   npx tsx scripts/recopy-version-from-locked.ts <badVersionId> --apply

import { db } from "@/lib/db";
import { createNewVersionFromLocked } from "@/lib/estimate-service";

const APPLY = process.argv.includes("--apply");
const VERSION_ID = process.argv.find((a) => !a.startsWith("--") && a.startsWith("c"));

async function main() {
  if (!VERSION_ID) {
    console.error("Usage: npx tsx scripts/recopy-version-from-locked.ts <badVersionId> [--apply]");
    process.exitCode = 1;
    return;
  }

  const bad = await db.estimateVersion.findUniqueOrThrow({
    where: { id: VERSION_ID },
    include: {
      sections: { include: { lineItems: true } },
      estimate: { select: { id: true, opportunity: { select: { showName: true } } } },
    },
  });

  console.log(`${bad.estimate.opportunity.showName} -- v${bad.versionNumber} (${bad.id})`);
  console.log(`  locked  ${bad.isLocked} | current ${bad.isCurrent}`);
  console.log(`  ${bad.sections.length} sections, ${bad.sections.flatMap((s) => s.lineItems).length} line items`);

  if (bad.isLocked) {
    console.log("\nRefusing: this version is locked. A locked version is history.");
    return;
  }

  // Anything pointing at it is work that would be destroyed with it.
  const blockers: string[] = [];
  const add = async (label: string, n: Promise<number>) => {
    const count = await n;
    if (count > 0) blockers.push(`${label}: ${count}`);
  };
  await add("proposals", db.proposal.count({ where: { estimateVersionId: bad.id } }));
  await add("bid packages", db.bidPackage.count({ where: { estimateVersionId: bad.id } }));
  await add("change orders", db.changeOrder.count({ where: { baseVersionId: bad.id } }));
  await add("cut list parts", db.cutListPart.count({ where: { estimateVersionId: bad.id } }));
  await add("cut sheets", db.cutSheet.count({ where: { estimateVersionId: bad.id } }));
  await add("vendor match logs", db.vendorMatchApplyLog.count({ where: { estimateVersionId: bad.id } }));
  await add("line item audit logs", db.lineItemAuditLog.count({ where: { estimateVersionId: bad.id } }));
  await add("accuracy flags", db.lineItemAccuracyFlag.count({ where: { estimateVersionId: bad.id } }));
  await add("internal costs", db.internalCost.count({ where: { estimateVersionId: bad.id } }));
  await add("proposal events", db.proposalEvent.count({ where: { estimateVersionId: bad.id } }));

  // An edit means someone has started working in here.
  const edited = bad.sections
    .flatMap((s) => s.lineItems)
    .filter((li) => li.updatedAt.getTime() - li.createdAt.getTime() > 2000).length;
  if (edited > 0) blockers.push(`line items edited since the copy: ${edited}`);

  if (blockers.length > 0) {
    console.log("\nRefusing -- this version is not untouched:");
    for (const b of blockers) console.log(`  ${b}`);
    console.log("\nSomeone's work lives here. Repair it by hand rather than replacing it.");
    return;
  }

  const source = await db.estimateVersion.findFirstOrThrow({
    where: { estimateId: bad.estimateId, versionNumber: bad.versionNumber - 1, isLocked: true },
    include: { sections: { where: { optionId: null } } },
  });
  const grouped = source.sections.filter((s) => s.groupLabel).length;
  const summarized = source.sections.filter((s) => s.boothSummary).length;

  console.log(`\nSource: v${source.versionNumber} (${source.id}), locked, ${source.sections.length} sections`);
  console.log(`  ${grouped} with a booth group, ${summarized} with a booth summary -- this is what the copy lost`);
  console.log("\nWould delete the bad copy entirely and re-run the fixed copy from that source.");

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  await db.$transaction(
    async (tx) => {
      await tx.lineItem.deleteMany({ where: { section: { estimateVersionId: bad.id } } });
      await tx.estimateSectionCategoryDescription.deleteMany({
        where: { section: { estimateVersionId: bad.id } },
      });
      await tx.estimateSection.deleteMany({ where: { estimateVersionId: bad.id } });
      await tx.option.deleteMany({ where: { estimateVersionId: bad.id } });
      await tx.categoryMarginOverride.deleteMany({ where: { estimateVersionId: bad.id } });
      await tx.estimateCategorySummary.deleteMany({ where: { estimateVersionId: bad.id } });
      await tx.estimateVersion.delete({ where: { id: bad.id } });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  console.log(`Deleted v${bad.versionNumber}.`);

  const fresh = await createNewVersionFromLocked(source.id);
  console.log(`Re-created v${fresh.versionNumber} (${fresh.id}).`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
