// What accepting a re-cost proposal actually does to the estimate.
//
// Step 6 of docs/recost-review.md, and the first one that writes to a
// client's numbers. The distinction it exists to make:
//
//   ACCEPTING is a decision. It always means something: an estimator
//   read a citation and agreed with it.
//
//   APPLYING is money moving. It only happens when there is a definite,
//   checkable change to make.
//
// Most accepted proposals on a real job have no money to move. "The
// hanging sign now displays additional text" against a $55,943 line is a
// genuine, agreed finding and there is nothing to apply: nobody has
// priced the revised sign. Pretending otherwise would mean either
// inventing a number or quietly doing nothing while reporting success.
// So this returns NOTHING_TO_APPLY with the reason, the proposal is
// still marked accepted, and the work stays visible as work.
//
// A leaf module: pure functions over plain rows, no db import.

import type { RecostActionValue } from "@/lib/recost-proposal";

export type ApplyEffect =
  | { kind: "DELETE_LINE_ITEM"; lineItemId: string }
  | { kind: "DELETE_SECTION_ITEMS"; sectionId: string }
  | { kind: "SET_UNIT_COST"; lineItemId: string; unitCost: number }
  | { kind: "SET_QTY"; lineItemId: string; qty: number }
  // Both moved. One effect rather than two, so the line item is written
  // once and its audit row reads as the single change it was.
  | { kind: "SET_QTY_AND_COST"; lineItemId: string; qty: number; unitCost: number }
  // Accepted, agreed, and there is no number to write. The reason is
  // shown rather than swallowed.
  | { kind: "NOTHING_TO_APPLY"; why: string };

export interface ApplicableProposal {
  action: RecostActionValue;
  lineItemId: string | null;
  sectionId: string | null;
  newUnitCost: number | null;
  newQty: number | null;
}

export function effectOf(proposal: ApplicableProposal): ApplyEffect {
  const { action, lineItemId, sectionId, newUnitCost, newQty } = proposal;

  switch (action) {
    case "REMOVE":
      if (lineItemId) return { kind: "DELETE_LINE_ITEM", lineItemId };
      if (sectionId) return { kind: "DELETE_SECTION_ITEMS", sectionId };
      return { kind: "NOTHING_TO_APPLY", why: "it does not name anything to remove" };

    case "REDUCE_QTY":
    case "ADJUST_QTY":
      if (lineItemId && newQty !== null && newUnitCost !== null) {
        return { kind: "SET_QTY_AND_COST", lineItemId, qty: newQty, unitCost: newUnitCost };
      }
      if (lineItemId && newQty !== null) return { kind: "SET_QTY", lineItemId, qty: newQty };
      return {
        kind: "NOTHING_TO_APPLY",
        why: "no new quantity was stated in the source, so there is nothing to reduce it to",
      };

    case "REPRICE":
    case "RE_SOURCE":
      if (lineItemId && newUnitCost !== null && newQty !== null) {
        return { kind: "SET_QTY_AND_COST", lineItemId, qty: newQty, unitCost: newUnitCost };
      }
      if (lineItemId && newUnitCost !== null) return { kind: "SET_UNIT_COST", lineItemId, unitCost: newUnitCost };
      return {
        kind: "NOTHING_TO_APPLY",
        // The common case, and the one the validation stage produces on
        // purpose: a price that was not in the source got stripped.
        why: "no price was stated in the source, so this still needs a number before it can be applied",
      };

    case "NEEDS_QUOTE":
      return { kind: "NOTHING_TO_APPLY", why: "nobody has priced this yet — it needs a quote" };

    case "ADD":
      return {
        kind: "NOTHING_TO_APPLY",
        why: "new scope has no price yet — add the line item once it has been priced",
      };
  }
}

// Whether accepting this proposal will change the estimate's total.
//
// Used to warn before the click rather than explain after it. An
// estimator about to delete 25 rows should be told it is 25 rows.
export function movesMoney(effect: ApplyEffect): boolean {
  return effect.kind !== "NOTHING_TO_APPLY";
}

// One sentence for the confirm, in the estimator's own units.
export function describeEffect(effect: ApplyEffect, context: { itemCount?: number; amount?: number }): string {
  const money = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  // A unit price keeps its cents. Rounding $6.75 to "$7" beside a
  // quantity reads as a different number than the one being written.
  const unitPrice = (n: number) =>
    n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

  switch (effect.kind) {
    case "DELETE_LINE_ITEM":
      return context.amount !== undefined
        ? `Removes this line item, taking ${money(context.amount)} of cost out of the version.`
        : "Removes this line item from the version.";
    case "DELETE_SECTION_ITEMS": {
      const count = context.itemCount ?? 0;
      return context.amount !== undefined
        ? `Removes all ${count} line items in this section, taking ${money(context.amount)} of cost out of the version.`
        : `Removes all ${count} line items in this section.`;
    }
    case "SET_UNIT_COST":
      return `Sets this line item's unit cost to ${unitPrice(effect.unitCost)}.`;
    case "SET_QTY":
      return `Sets this line item's quantity to ${effect.qty}.`;
    case "SET_QTY_AND_COST":
      return `Sets this line item to ${effect.qty} at ${unitPrice(effect.unitCost)}.`;
    case "NOTHING_TO_APPLY":
      return `Records the decision — ${effect.why}.`;
  }
}
