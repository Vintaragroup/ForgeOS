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
  }[];
  // Said out loud rather than left to be noticed: a review assembled
  // from a schedule alone has not seen the quotes.
  notes: string[];
}
