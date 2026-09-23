// Repairs a version that was copied before lineItemCreateData carried the
// descriptive fields.
//
// createNewVersionFromLocked used to copy six fields per line item and
// drop the rest, so every version created from a locked one lost its
// items' `category` (and subgroup, unit, sort order, position, flags and
// `documentId`). On Full Swing PGA Show Orlando that turned version 2 into
// 369 uncategorized rows the moment it was created, and a version with an
// unclean category audit cannot be sent -- sendProposal refuses it.
//
// The fix is in lineItemCreateData now. This puts back what the versions
// created before that fix already lost.
//
// Matching: the target is a byte-for-byte copy of the source that nobody
// has edited yet, so items are paired within each section by their order
// of creation, and every pair is checked to have the same description
// before anything is written. A section or item that cannot be matched
// confidently is reported and skipped rather than guessed at.
//
//   npx tsx scripts/repair-copied-version-fields.ts <estimateVersionId>
//   npx tsx scripts/repair-copied-version-fields.ts <estimateVersionId> --apply

import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");
const targetVersionId = process.argv[2];

async function main() {
  if (!targetVersionId || targetVersionId.startsWith("--")) {
    throw new Error("Pass the id of the version to repair.");
  }

  const target = await db.estimateVersion.findUniqueOrThrow({
    where: { id: targetVersionId },
    include: { sections: { include: { lineItems: { orderBy: { id: "asc" } } } } },
  });
  if (target.isLocked) {
    throw new Error(`Version ${target.versionNumber} is locked; refusing to rewrite a locked version.`);
  }

  // The version this one was copied from: the highest-numbered locked
  // version below it on the same estimate.
  const source = await db.estimateVersion.findFirst({
    where: { estimateId: target.estimateId, isLocked: true, versionNumber: { lt: target.versionNumber } },
    orderBy: { versionNumber: "desc" },
    include: { sections: { include: { lineItems: { orderBy: { id: "asc" } } } } },
  });
  if (!source) throw new Error("No earlier locked version to copy from.");

  console.log(`Repairing v${target.versionNumber} from v${source.versionNumber}${APPLY ? "" : " (dry run)"}`);

  // Section names repeat -- this estimate has two called "Audio/Visual" --
  // so a name cannot be a key on its own. Same-named sections are paired
  // in the order they appear, which is the order they were copied in.
  const sourceByName = new Map<string, typeof source.sections>();
  for (const sec of source.sections) {
    const list = sourceByName.get(sec.name) ?? [];
    list.push(sec);
    sourceByName.set(sec.name, list);
  }
  const takenPerName = new Map<string, number>();

  let repaired = 0;
  let alreadyFine = 0;
  const skipped: string[] = [];

  for (const section of target.sections) {
    const candidates = sourceByName.get(section.name) ?? [];
    const nth = takenPerName.get(section.name) ?? 0;
    const from = candidates[nth];
    takenPerName.set(section.name, nth + 1);
    if (!from) {
      skipped.push(`section "${section.name}" (#${nth + 1}) has no match in v${source.versionNumber}`);
      continue;
    }

    // Matched by description, not by position: sortOrder was one of the
    // fields the broken copy dropped, so the target's order is not the
    // source's order and position means nothing here. A description that
    // appears more than once in a section is handed out in order.
    const pool = new Map<string, typeof from.lineItems>();
    for (const li of from.lineItems) {
      const list = pool.get(li.description) ?? [];
      list.push(li);
      pool.set(li.description, list);
    }

    for (const to of section.lineItems) {
      const queue = pool.get(to.description);
      const src = queue?.shift();
      if (!src) {
        skipped.push(`"${to.description.slice(0, 60)}" has no counterpart in v${source.versionNumber}`);
        continue;
      }
      if (to.category === src.category && to.documentId === src.documentId && to.sortOrder === src.sortOrder) {
        alreadyFine++;
        continue;
      }
      repaired++;
      if (APPLY) {
        await db.lineItem.update({
          where: { id: to.id },
          data: {
            category: src.category,
            subgroupLabel: src.subgroupLabel,
            sortOrder: src.sortOrder,
            isClientOwned: src.isClientOwned,
            usageTag: src.usageTag,
            unit: src.unit,
            positionCode: src.positionCode,
            includeInProposal: src.includeInProposal,
            documentId: src.documentId,
            sourceQuote: src.sourceQuote,
            sourcePageNumber: src.sourcePageNumber,
          },
        });
      }
    }
  }

  console.log(`  ${repaired} line item(s) ${APPLY ? "repaired" : "would be repaired"}`);
  console.log(`  ${alreadyFine} already correct`);
  if (skipped.length) {
    console.log(`  ${skipped.length} skipped:`);
    for (const s of skipped.slice(0, 20)) console.log(`    - ${s}`);
  }
  if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
