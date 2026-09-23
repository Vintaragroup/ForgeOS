// Undoes a signature that was never a signature.
//
// ABC Chicago was marked sent and signed in the same minute by a stray
// click: the sign form replaces the send form in the same slot, and the
// browser had autofilled the signer name (see aa66a73, which makes that
// impossible going forward). The client had actually asked for a revised
// design and quote -- the opposite of acceptance.
//
// Signing is not just a status. It advanced the Opportunity to WON and
// created a Project, so three things have to come back:
//
//   1. the Proposal returns to SENT, keeping its real send date
//   2. the auto-created Project is soft-deleted
//   3. the Opportunity returns to whatever stage it was in before WON
//
// The SIGNED ProposalEvent is NOT deleted. It happened, a person caused
// it, and proposal_events is ON DELETE RESTRICT precisely because this
// history is meant to be append-only. A correcting event is appended
// instead, so the record reads "signed, then unwound, because X" rather
// than silently never having happened.
//
//   npx tsx scripts/unwind-accidental-signature.ts <proposalId>
//   npx tsx scripts/unwind-accidental-signature.ts <proposalId> --apply
//
// Against production:
//   DATABASE_URL=<prod> npx tsx scripts/unwind-accidental-signature.ts <id> --apply

import { db } from "@/lib/db";

const APPLY = process.argv.includes("--apply");
const PROPOSAL_ID = process.argv.find((a) => !a.startsWith("--") && a.startsWith("c"));

const REASON = "Unwound: recorded by a mis-click, the client had not accepted this proposal.";

async function main() {
  if (!PROPOSAL_ID) {
    console.error("Usage: npx tsx scripts/unwind-accidental-signature.ts <proposalId> [--apply]");
    process.exitCode = 1;
    return;
  }

  const proposal = await db.proposal.findUniqueOrThrow({
    where: { id: PROPOSAL_ID },
    include: {
      events: { orderBy: { createdAt: "asc" } },
      estimateVersion: {
        select: {
          versionNumber: true,
          estimate: {
            select: {
              opportunityId: true,
              opportunity: {
                select: {
                  id: true,
                  showName: true,
                  stage: true,
                  stageEvents: { orderBy: { changedAt: "desc" }, take: 5 },
                  projects: { where: { deletedAt: null }, select: { id: true, jobNumber: true, status: true, createdAt: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const opportunity = proposal.estimateVersion.estimate.opportunity;
  console.log(`${opportunity.showName} -- proposal v${proposal.estimateVersion.versionNumber} (${proposal.id})`);
  console.log(`  status      ${proposal.status}`);
  console.log(`  sentAt      ${proposal.sentAt?.toISOString() ?? "never"}`);
  console.log(`  signedAt    ${proposal.signedAt?.toISOString() ?? "never"}`);
  console.log(`  signedBy    ${proposal.signedByName ?? "--"}${proposal.signedByTitle ? `, ${proposal.signedByTitle}` : ""}`);
  console.log(`  opportunity ${opportunity.stage}`);

  if (proposal.status !== "SIGNED") {
    console.log(`\nNothing to do -- this proposal is ${proposal.status}, not SIGNED.`);
    return;
  }
  if (!proposal.sentAt) {
    console.log("\nRefusing: this proposal has no send date, so SENT is not a state it can return to.");
    return;
  }

  // The stage to go back to is whatever the WON event moved it FROM.
  // Guessing a default here would quietly invent history; if the event
  // is missing, that is a thing to look at rather than paper over.
  const wonEvent = opportunity.stageEvents.find((e) => e.toStage === "WON");
  const previousStage = wonEvent?.fromStage ?? null;

  console.log("\nWould change:");
  console.log(`  proposal    SIGNED -> SENT, clearing signedAt/signedByName/signedByTitle`);
  console.log(`              (sentAt stays ${proposal.sentAt.toISOString()})`);
  console.log(`  event       + a correcting event SIGNED -> SENT saying why (the SIGNED event stays)`);

  if (opportunity.stage === "WON") {
    if (previousStage) {
      console.log(`  opportunity WON -> ${previousStage} (from the stage event that set it)`);
    } else {
      console.log(`  opportunity WON -> UNCHANGED -- no stage event records what it was before. Look at this by hand.`);
    }
  } else {
    console.log(`  opportunity ${opportunity.stage} -- not WON, left alone`);
  }

  // Only a Project created at signing time. An older Project on the same
  // opportunity is somebody's real work and is never touched.
  const signedAtMs = proposal.signedAt!.getTime();
  const autoCreated = opportunity.projects.filter((p) => Math.abs(p.createdAt.getTime() - signedAtMs) < 5 * 60 * 1000);
  const older = opportunity.projects.filter((p) => !autoCreated.includes(p));

  for (const p of autoCreated) {
    console.log(`  project     soft-delete project ${p.jobNumber ?? "(no job number)"} (${p.id}), created ${p.createdAt.toISOString()}`);
  }
  for (const p of older) {
    console.log(`  project     LEAVING ${p.jobNumber ?? "(no job number)"} (${p.id}) -- predates the signature, not ours to remove`);
  }
  if (autoCreated.length === 0) {
    console.log("  project     none created at signing time");
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  await db.$transaction(async (tx) => {
    await tx.proposal.update({
      where: { id: proposal.id },
      data: { status: "SENT", signedAt: null, signedByName: null, signedByTitle: null },
    });
    await tx.proposalEvent.create({
      data: {
        proposalId: proposal.id,
        fromStatus: "SIGNED",
        toStatus: "SENT",
        note: REASON,
        estimateVersionId: proposal.estimateVersionId,
      },
    });
    for (const p of autoCreated) {
      await tx.project.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
    }
    if (opportunity.stage === "WON" && previousStage) {
      await tx.opportunity.update({ where: { id: opportunity.id }, data: { stage: previousStage } });
      await tx.stageChangeEvent.create({
        data: { opportunityId: opportunity.id, fromStage: "WON", toStage: previousStage, note: REASON },
      });
    }
  });

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
