// Collapses duplicate unsent proposal drafts to one per estimate version.
//
// generateProposal used to create a row every time it was called, so
// pressing "Generate proposal" twice left two identical drafts with
// nothing to say which one to send. Full Swing American Baseball Chicago
// reached eight, none of them sent.
//
// generateProposal refreshes the existing draft now, so this is a
// one-time tidy of what the old behaviour already produced.
//
// Only ever touches UNSENT drafts. A sent proposal is the record of what
// a client actually received and is never collapsed, merged or removed --
// even if two were somehow sent from one version, both are true.
//
// Soft delete, matching how everything else in this app removes things:
// the rows stay, and a proposal carrying lifecycle history could not be
// hard deleted anyway (proposal_events is ON DELETE RESTRICT).
//
//   npx tsx scripts/dedupe-unsent-proposals.ts
//   npx tsx scripts/dedupe-unsent-proposals.ts --apply

import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

async function main() {
  const drafts = await db.proposal.findMany({
    where: { deletedAt: null, sentAt: null },
    select: {
      id: true,
      createdAt: true,
      estimateVersionId: true,
      estimateVersion: {
        select: { versionNumber: true, estimate: { select: { opportunity: { select: { showName: true } } } } },
      },
      _count: { select: { events: true } },
    },
    // Newest first, so the one kept is the one someone most recently
    // meant to produce.
    orderBy: { createdAt: "desc" },
  });

  const byVersion = new Map<string, typeof drafts>();
  for (const d of drafts) {
    const list = byVersion.get(d.estimateVersionId) ?? [];
    list.push(d);
    byVersion.set(d.estimateVersionId, list);
  }

  let removed = 0;
  for (const [, list] of byVersion) {
    if (list.length < 2) continue;
    const [keep, ...rest] = list;
    const label = `${list[0].estimateVersion.estimate.opportunity.showName} v${list[0].estimateVersion.versionNumber}`;
    console.log(`${label}: keeping ${keep.id} (${keep.createdAt.toISOString().slice(0, 10)}), removing ${rest.length}`);

    for (const dup of rest) {
      // A draft that somehow carries history is left alone and reported:
      // history means something happened to it, and this script is only
      // meant to clear away rows nothing ever happened to.
      if (dup._count.events > 0) {
        console.log(`   skipped ${dup.id} -- has ${dup._count.events} lifecycle event(s)`);
        continue;
      }
      removed++;
      if (APPLY) {
        await db.proposal.update({ where: { id: dup.id }, data: { deletedAt: new Date() } });
      }
    }
  }

  console.log(`\n${removed} draft(s) ${APPLY ? "removed" : "would be removed"}`);
  if (!APPLY) console.log("Dry run. Re-run with --apply to write.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
