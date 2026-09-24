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
// There is no bulk apply, deliberately. Every row here came from a model
// reading a drawing, and "accept all" is the affordance that turns a
// reviewed list into an unreviewed one.

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

  if (changedLineItems > 0) await recomputeVersionTotals(proposal.estimateVersionId);

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

    case "NOTHING_TO_APPLY":
      return 0;
  }
}
