// The shape of a re-cost review.
//
// Separate from recost-review-service.ts, which assembles one and
// imports db. Components render this type, and a component importing it
// from the service would pull Prisma into the browser bundle -- the same
// split drawing-comparison.ts already makes for the same reason.

import type { CorroborationFinding } from "@/lib/recost-corroboration";
import type { ElementChange } from "@/lib/recost-status";
import type { RecostRollup } from "@/lib/recost-rollup";

export interface RecostReview {
  estimateVersionId: string;
  versionNumber: number;
  // The client's own words, and the number read out of them.
  requestNote: string | null;
  requestedAt: Date | null;
  rollup: RecostRollup;
  // Element-level detail behind a re-costed line, when a revised
  // schedule was found.
  elementChanges: ElementChange[];
  // Biggest untouched elements, named only when still over target.
  suggestions: { label: string; cost: number }[];
  // What the revised drawing shows against what the schedule re-costed.
  // Null when no drawing has been compared -- which is different from
  // compared and found nothing.
  drawing: {
    revisedFilename: string;
    previousFilename: string;
    headline: string;
    charactersMismatched: boolean;
    findings: CorroborationFinding[];
  } | null;
  // What the AI stage proposed, still awaiting a decision. Empty until
  // somebody runs it, and every row here has already survived
  // validation against real ids and verbatim quotes -- see
  // recost-proposal.ts.
  proposals: {
    id: string;
    action: string;
    confidence: string;
    reason: string;
    target: string;
    amount: number | null;
    sourceQuote: string;
    sourceFilename: string;
    // What the line item costs now, and what it would cost if this were
    // applied. Null when the proposal names no priced row.
    amountAfter: number | null;
    // What accepting it would do, said before the click rather than
    // explained after it. See recost-apply.ts.
    effect: string;
    movesMoney: boolean;
  }[];
  // The line-item comparison of the two workbooks: which rows of the
  // open version need updating, and by how much. Deterministic -- rows
  // join on the description the import itself composed, so nothing here
  // resembles or infers. Null when no pair of cost breakouts was found.
  lineItemDiff: {
    costDelta: number;
    changedRows: number;
    removedRows: number;
    addedRows: number;
    // Disagreement between this and the estimator's own Summary column,
    // when there is any. Two reads of one workbook that differ is a fact
    // worth showing rather than a number to pick between.
    disagreesWithSummaryBy: number | null;
    elements: {
      tab: string;
      titleChanged: boolean;
      previousTitle: string;
      currentTitle: string;
      elementRemoved: boolean;
      previousTotal: number;
      currentTotal: number;
      changes: {
        kind: string;
        description: string;
        variant: string | null;
        previousQty: number | null;
        currentQty: number | null;
        previousUnitCost: number | null;
        currentUnitCost: number | null;
        costDelta: number | null;
      }[];
    }[];
  } | null;
  // What the one bulk affordance would touch, so the button can say it
  // before the click. Recommended proposals only -- never a removal,
  // never anything a model proposed.
  recommended: { count: number; costDelta: number };
  // Decisions already made, newest first. The line-item history records
  // WHAT changed and offers Restore; this records WHY, with the citation
  // the decision was made against. Neither is complete alone.
  decided: {
    id: string;
    status: string;
    action: string;
    target: string;
    reason: string;
    sourceQuote: string;
    decidedBy: string;
    decidedAt: Date | null;
  }[];
  // Said out loud rather than left to be noticed: a review assembled
  // from a schedule alone has not seen the quotes.
  notes: string[];
}
