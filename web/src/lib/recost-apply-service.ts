// Deciding a re-cost proposal, and applying it when there is something
// to apply.
//
// Step 6 of docs/recost-review.md. Everything before this produced
// findings and proposals; this is where a human's answer changes a
// client's numbers, so the posture is different from every stage before
// it:
//
//   a decision is recorded whether or not money moves
//   a proposal can be decided exactly once
//   a locked version is never touched
//   a removal is restorable, because deleteLineItem snapshots first
//
// There is one bulk path, and it is narrow on purpose. "Accept all" is
// the affordance that turns a reviewed list into an unreviewed one, so
// it reaches only proposals that carry RECOMMEND_AND_CONFIRM -- which on
// a real job means the ones read row by row out of the estimating lead's
// own workbook, with no model between the file and the screen. A removal
// is never in it, whatever its source, and neither is anything a model
// proposed: those stay one decision at a time.

import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { deleteLineItem, recomputeVersionTotals, updateLineItem } from "@/lib/estimate-service";
import { effectOf, type ApplyEffect } from "@/lib/recost-apply";

export interface DecisionOutcome {
  status: "ACCEPTED" | "REJECTED" | "APPLIED";
  effect: ApplyEffect | null;
  // How many line items actually changed. Zero is a legitimate,
  // reportable outcome -- see recost-apply.ts on accepting something
  // with nothing to apply.
  changedLineItems: number;
}

export async function decideRecostProposal(
  proposalId: string,
  opportunityId: string,
  userId: string,
  decision: "ACCEPT" | "REJECT",
  // The batch path totals up once at the end rather than 56 times. Only
  // it passes this; a single decision always recomputes.
  options: { skipRecompute?: boolean } = {},
): Promise<DecisionOutcome> {
  const proposal = await db.recostProposal.findFirst({
    where: { id: proposalId, estimateVersion: { estimate: { opportunityId } } },
  });
  // Scoped by opportunity rather than looked up by id alone: a proposal
  // id from another client's estimate must not resolve here, the same
  // discipline deleteLineItem's own header describes.
  if (!proposal) throw new UserError("That proposal is no longer on this estimate.");

  // Decided once. A re-run only ever replaces PROPOSED rows, so a second
  // click on a stale screen would otherwise re-delete a line item that
  // has already gone -- or worse, succeed against a different one.
  if (proposal.status !== "PROPOSED") {
    throw new UserError(`This was already ${proposal.status.toLowerCase()}. Re-run the review to start again.`);
  }

  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: proposal.estimateVersionId },
    select: { id: true, isLocked: true },
  });
  if (version.isLocked) {
    // v1 is what the client received. estimate-service asserts this too;
    // saying it here means the estimator reads a sentence rather than a
    // stack trace.
    throw new UserError("This version is locked. Re-costing happens on the open version.");
  }

  if (decision === "REJECT") {
    await db.recostProposal.update({
      where: { id: proposalId },
      data: { status: "REJECTED", decidedById: userId, decidedAt: new Date() },
    });
    return { status: "REJECTED", effect: null, changedLineItems: 0 };
  }

  const effect = effectOf({
    action: proposal.action,
    lineItemId: proposal.lineItemId,
    sectionId: proposal.sectionId,
    newUnitCost: proposal.newUnitCost?.toNumber() ?? null,
    newQty: proposal.newQty?.toNumber() ?? null,
  });

  const changedLineItems = await applyEffect(effect, opportunityId, userId);

  // ACCEPTED when the decision stands but nothing moved; APPLIED when it
  // did. Two different states on purpose -- "accepted, still needs a
  // quote" is the most common real outcome and it is not done.
  const status = changedLineItems > 0 ? "APPLIED" : "ACCEPTED";
  await db.recostProposal.update({
    where: { id: proposalId },
    data: { status, decidedById: userId, decidedAt: new Date() },
  });

  if (changedLineItems > 0 && !options.skipRecompute) {
    await recomputeVersionTotals(proposal.estimateVersionId);
  }

  return { status, effect, changedLineItems };
}

// Each branch goes through estimate-service rather than touching rows
// directly, which is what gets the LineItemAuditLog entry and, for a
// delete, the snapshot that makes it restorable.
async function applyEffect(effect: ApplyEffect, opportunityId: string, userId: string): Promise<number> {
  switch (effect.kind) {
    case "DELETE_LINE_ITEM":
      await deleteLineItem(opportunityId, effect.lineItemId, userId);
      return 1;

    case "DELETE_SECTION_ITEMS": {
      const items = await db.lineItem.findMany({
        where: { sectionId: effect.sectionId },
        select: { id: true },
      });
      // One at a time, so every row gets its own audit entry and its own
      // restore snapshot. A deleteMany would be faster and would leave
      // 25 line items with no way back.
      for (const item of items) {
        await deleteLineItem(opportunityId, item.id, userId);
      }
      return items.length;
    }

    case "SET_UNIT_COST":
      await updateLineItem(opportunityId, effect.lineItemId, { unitCost: effect.unitCost }, userId);
      return 1;

    case "SET_QTY":
      await updateLineItem(opportunityId, effect.lineItemId, { qty: effect.qty }, userId);
      return 1;

    case "SET_QTY_AND_COST":
      await updateLineItem(
        opportunityId,
        effect.lineItemId,
        { qty: effect.qty, unitCost: effect.unitCost },
        userId,
      );
      return 1;

    case "NOTHING_TO_APPLY":
      return 0;
  }
}


export interface BatchOutcome {
  applied: number;
  changedLineItems: number;
  // Each failure named rather than counted. One proposal pointing at a
  // line item somebody deleted in another tab must not abandon the other
  // fifty-five.
  failed: { proposalId: string; why: string }[];
}

// Accepts every proposal on this version that was recommended rather
// than questioned.
//
// What that excludes is the whole safety of it: no removal, and nothing
// a model proposed. On Full Swing this reaches the 56 quantity and price
// changes read out of the revised workbook and leaves the 40 removals
// and the 4 drawing findings exactly where they are.
//
// Each one still goes through decideRecostProposal, so each still writes
// its own audit row and each removal -- if one ever qualified -- would
// still be restorable on its own. The only thing batched is the clicking.
export async function acceptRecommendedRecosts(
  estimateId: string,
  opportunityId: string,
  userId: string,
): Promise<BatchOutcome> {
  const version = await db.estimateVersion.findFirst({
    where: { estimate: { id: estimateId, opportunityId }, isLocked: false },
    orderBy: { versionNumber: "desc" },
    select: { id: true },
  });
  if (!version) throw new UserError("This estimate has no open version to re-cost.");

  const eligible = await db.recostProposal.findMany({
    where: {
      estimateVersionId: version.id,
      status: "PROPOSED",
      confidence: "RECOMMEND_AND_CONFIRM",
      // Belt and braces. Nothing sets a removal to
      // RECOMMEND_AND_CONFIRM on a value-engineering job, and this makes
      // that impossible to change by accident somewhere else.
      action: { notIn: ["REMOVE"] },
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (eligible.length === 0) {
    throw new UserError("Nothing here is recommended — every open proposal needs a decision of its own.");
  }

  let applied = 0;
  let changedLineItems = 0;
  const failed: { proposalId: string; why: string }[] = [];

  for (const { id } of eligible) {
    try {
      const outcome = await decideRecostProposal(id, opportunityId, userId, "ACCEPT", { skipRecompute: true });
      applied += 1;
      changedLineItems += outcome.changedLineItems;
    } catch (err) {
      failed.push({ proposalId: id, why: err instanceof Error ? err.message : String(err) });
    }
  }

  if (changedLineItems > 0) await recomputeVersionTotals(version.id);
  if (failed.length > 0) console.warn(`[recost] ${failed.length} of ${eligible.length} batch accepts failed:`, failed);

  return { applied, changedLineItems, failed };
}


// Accepts every outstanding removal for one element.
//
// The spec said this from the start and the screen did not do it: an
// estimator thinks about "the reception counter" as one thing, not as 23
// separate removals. On Full Swing the 40 remaining removals are exactly
// two elements -- the reception counter and the 5'4" sign -- so this is
// two decisions rather than forty, and each is the decision somebody
// actually makes.
//
// Scoped to one element rather than offered as "accept all removals",
// because taking out a counter and taking out a sign are two different
// calls and collapsing them would hide that.
export async function acceptRemovalsForElement(
  estimateId: string,
  opportunityId: string,
  userId: string,
  element: string,
): Promise<BatchOutcome> {
  const version = await db.estimateVersion.findFirst({
    where: { estimate: { id: estimateId, opportunityId }, isLocked: false },
    orderBy: { versionNumber: "desc" },
    select: { id: true },
  });
  if (!version) throw new UserError("This estimate has no open version to re-cost.");

  const eligible = await db.recostProposal.findMany({
    where: { estimateVersionId: version.id, status: "PROPOSED", action: "REMOVE", sourceLocation: element },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (eligible.length === 0) throw new UserError(`No removals are waiting for ${element}.`);

  let applied = 0;
  let changedLineItems = 0;
  const failed: { proposalId: string; why: string }[] = [];

  for (const { id } of eligible) {
    try {
      const outcome = await decideRecostProposal(id, opportunityId, userId, "ACCEPT", { skipRecompute: true });
      applied += 1;
      changedLineItems += outcome.changedLineItems;
    } catch (err) {
      failed.push({ proposalId: id, why: err instanceof Error ? err.message : String(err) });
    }
  }

  if (changedLineItems > 0) await recomputeVersionTotals(version.id);
  if (failed.length > 0) console.warn(`[recost] ${failed.length} of ${eligible.length} removals failed for ${element}:`, failed);

  return { applied, changedLineItems, failed };
}
