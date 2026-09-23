// Removes a duplicate estimate version, leaving exactly one current.
//
// requestProposalRevisions used to copy unconditionally, so requesting a
// change on an estimate that already had a version open produced a
// second one beside it -- same number, both isCurrent, the re-costing
// work split across two places with nothing to say which was real. Fixed
// in 1200de8; this clears up the rows that bug already made.
//
// It refuses unless the version being dropped is genuinely disposable:
// unlocked, unedited since it was created, and referenced by nothing. If
// someone has started working in it, that work is real -- pick the other
// one to drop, or merge by hand.
//
//   npx tsx scripts/drop-duplicate-version.ts <dropId> <keepId>
//   npx tsx scripts/drop-duplicate-version.ts <dropId> <keepId> --apply

import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");
const [DROP, KEEP] = process.argv.slice(2).filter((a) => !a.startsWith("--"));

async function inspect(id: string, label: string) {
  const v = await db.estimateVersion.findUniqueOrThrow({
    where: { id },
    include: {
      sections: { where: { optionId: null }, include: { lineItems: true } },
      estimate: { select: { id: true, opportunity: { select: { showName: true } } } },
    },
  });
  const items = v.sections.flatMap((s) => s.lineItems);
  const edited = items.filter((li) => li.updatedAt.getTime() - li.createdAt.getTime() > 2000).length;
  const booths = new Set(v.sections.map((s) => s.groupLabel).filter(Boolean)).size;

  const refs: Record<string, number> = {
    proposals: await db.proposal.count({ where: { estimateVersionId: id } }),
    bidPackages: await db.bidPackage.count({ where: { estimateVersionId: id } }),
    changeOrders: await db.changeOrder.count({ where: { baseVersionId: id } }),
    cutListParts: await db.cutListPart.count({ where: { estimateVersionId: id } }),
    cutSheets: await db.cutSheet.count({ where: { estimateVersionId: id } }),
    auditLogs: await db.lineItemAuditLog.count({ where: { estimateVersionId: id } }),
    accuracyFlags: await db.lineItemAccuracyFlag.count({ where: { estimateVersionId: id } }),
    internalCosts: await db.internalCost.count({ where: { estimateVersionId: id } }),
    proposalEvents: await db.proposalEvent.count({ where: { estimateVersionId: id } }),
  };
  const held = Object.entries(refs).filter(([, n]) => n > 0);

  console.log(`${label}  v${v.versionNumber}  ${id}`);
  console.log(`   current=${v.isCurrent} locked=${v.isLocked} total=${v.grandTotal}`);
  console.log(`   sections=${v.sections.length} items=${items.length} booths=${booths} edited=${edited}`);
  console.log(`   references: ${held.length === 0 ? "none" : held.map(([k, n]) => `${k}=${n}`).join(", ")}`);

  return { version: v, edited, held: held.map(([k, n]) => `${k}=${n}`), estimateId: v.estimateId };
}

async function main() {
  if (!DROP || !KEEP) {
    console.error("Usage: npx tsx scripts/drop-duplicate-version.ts <dropId> <keepId> [--apply]");
    process.exitCode = 1;
    return;
  }

  const drop = await inspect(DROP, "DROP");
  const keep = await inspect(KEEP, "KEEP");

  if (drop.estimateId !== keep.estimateId) {
    console.log("\nRefusing: these belong to different estimates, so they are not duplicates.");
    return;
  }
  if (drop.version.isLocked) {
    console.log("\nRefusing: the version to drop is locked. A locked version is history.");
    return;
  }
  if (drop.edited > 0 || drop.held.length > 0) {
    console.log(`\nRefusing: the version to drop is not disposable (${[...drop.held, `edited=${drop.edited}`].join(", ")}).`);
    console.log("Someone's work lives there. Drop the other one, or reconcile by hand.");
    return;
  }

  console.log(`\nWould delete v${drop.version.versionNumber} (${DROP}) and leave ${KEEP} as the only current version.`);
  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  await db.$transaction(
    async (tx) => {
      await tx.lineItem.deleteMany({ where: { section: { estimateVersionId: DROP } } });
      await tx.estimateSectionCategoryDescription.deleteMany({ where: { section: { estimateVersionId: DROP } } });
      await tx.estimateSection.deleteMany({ where: { estimateVersionId: DROP } });
      await tx.option.deleteMany({ where: { estimateVersionId: DROP } });
      await tx.categoryMarginOverride.deleteMany({ where: { estimateVersionId: DROP } });
      await tx.estimateCategorySummary.deleteMany({ where: { estimateVersionId: DROP } });
      await tx.estimateVersion.delete({ where: { id: DROP } });
      // Explicit rather than assumed: the survivor is the current one.
      await tx.estimateVersion.updateMany({
        where: { estimateId: keep.estimateId, isCurrent: true },
        data: { isCurrent: false },
      });
      await tx.estimateVersion.update({ where: { id: KEEP }, data: { isCurrent: true } });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  const remaining = await db.estimateVersion.findMany({
    where: { estimateId: keep.estimateId },
    orderBy: { versionNumber: "asc" },
    select: { id: true, versionNumber: true, isCurrent: true, isLocked: true },
  });
  console.log("\nRemaining versions:");
  for (const v of remaining) {
    console.log(`  v${v.versionNumber} ${v.id} current=${v.isCurrent} locked=${v.isLocked}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
