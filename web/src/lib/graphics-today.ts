// What the Graphics department actually has to do today, derived from the
// SOP rather than from the raw status enum.
//
// The dashboard used to answer "how many pieces are in each status," which
// is a report, not a queue -- a producer still had to know that
// PROOF_SUBMITTED is theirs and PROOF_IN_PROGRESS is the vendor's, and
// nothing on the page said a piece was going to miss its in-hand date until
// it already had.
//
// Two questions decide every row here:
//
//   1. Is this piece going to be late, or cost a rush fee? -- graphics-sla
//      answers that from the material's turnaround and the in-hand date.
//   2. Whose move is it? -- WAITING_ON below answers that from the status.
//
// A leaf module: pure functions over plain data, no db import, so the page
// and the tests can both use it.

import type { ArtworkOrderStatus } from "@/generated/prisma/enums";
import {
  APPROVAL_LEAD_BUSINESS_DAYS,
  businessDaysBetween,
  materialClassIsKnown,
  slaStatus,
  type SlaStatus,
} from "@/lib/graphics-sla";

// Whose move it is. NOBODY covers the states where the piece is simply
// travelling or finished -- nothing to chase.
export type WaitingOn = "EXPO" | "CLIENT" | "VENDOR" | "NOBODY";

// Read straight off ARTWORK_TRANSITIONS in artwork-order-service: whoever
// performs the only legal outgoing transition is who the piece is waiting
// on. PROOF_UNDER_REVIEW is the client's, not ours -- the sign-off that
// leaves it lives in the client portal (client-portal/[token]/actions.ts's
// CLIENT_SIGN_OFF), even though an Expo action put it there.
export const WAITING_ON: Record<ArtworkOrderStatus, WaitingOn> = {
  INVITED: "CLIENT",
  ORDER_DRAFTED: "CLIENT",
  SUBMITTED: "EXPO",
  UNDER_ART_REVIEW: "EXPO",
  REJECTED: "CLIENT",
  ACCEPTED: "EXPO",
  VENDOR_ASSIGNED: "VENDOR",
  PROOF_IN_PROGRESS: "VENDOR",
  PROOF_SUBMITTED: "EXPO",
  EXPO_PROOF_CHECK: "EXPO",
  PROOF_REVISION_REQUESTED: "VENDOR",
  ESCALATED: "EXPO",
  PROOF_UNDER_REVIEW: "CLIENT",
  PROOF_APPROVED: "EXPO",
  PRODUCTION_GO_AHEAD: "VENDOR",
  IN_PRODUCTION: "VENDOR",
  RECEIVED_FROM_VENDOR: "EXPO",
  INSPECTED: "EXPO",
  PACKAGED_READY: "EXPO",
  SHIPPED_TO_SHOW: "NOBODY",
  DELIVERED_AT_SHOW: "NOBODY",
  REPRINT_REQUESTED: "VENDOR",
  CANCELLED: "NOBODY",
};

// The next thing that has to happen, phrased as the action rather than the
// state. "Assign a vendor" is a row someone can act on; "ACCEPTED" is a row
// someone has to decode first.
export const NEXT_STEP: Record<ArtworkOrderStatus, string> = {
  INVITED: "Client to start the order",
  ORDER_DRAFTED: "Client to submit",
  SUBMITTED: "Start art review",
  UNDER_ART_REVIEW: "Review the art",
  REJECTED: "Client to resubmit",
  ACCEPTED: "Assign a vendor",
  VENDOR_ASSIGNED: "Vendor to start the proof",
  PROOF_IN_PROGRESS: "Vendor proofing",
  PROOF_SUBMITTED: "Start proof check",
  EXPO_PROOF_CHECK: "Check the proof",
  PROOF_REVISION_REQUESTED: "Vendor to revise",
  ESCALATED: "Resolve the escalation",
  PROOF_UNDER_REVIEW: "Client to sign off",
  PROOF_APPROVED: "Give production go-ahead",
  PRODUCTION_GO_AHEAD: "Vendor to start production",
  IN_PRODUCTION: "In production",
  RECEIVED_FROM_VENDOR: "Inspect",
  INSPECTED: "Package",
  PACKAGED_READY: "Ship to show",
  SHIPPED_TO_SHOW: "In transit",
  DELIVERED_AT_SHOW: "Delivered",
  REPRINT_REQUESTED: "Vendor to reprint",
  CANCELLED: "Cancelled",
};

// Past this point the piece physically exists, so an in-hand date it
// already met is not a problem and a rush fee can no longer be incurred.
const PRODUCTION_SETTLED: ReadonlySet<ArtworkOrderStatus> = new Set([
  "PACKAGED_READY",
  "SHIPPED_TO_SHOW",
  "DELIVERED_AT_SHOW",
  "CANCELLED",
]);

// "All show graphics must be approved within 10 business days of show site
// set-up" -- these are the states where that approval still hasn't
// happened. PROOF_APPROVED itself is the approval, so it is not here.
const PRE_APPROVAL: ReadonlySet<ArtworkOrderStatus> = new Set([
  "INVITED",
  "ORDER_DRAFTED",
  "SUBMITTED",
  "UNDER_ART_REVIEW",
  "REJECTED",
  "ACCEPTED",
  "VENDOR_ASSIGNED",
  "PROOF_IN_PROGRESS",
  "PROOF_SUBMITTED",
  "EXPO_PROOF_CHECK",
  "PROOF_REVISION_REQUESTED",
  "ESCALATED",
  "PROOF_UNDER_REVIEW",
]);

// The facts each bucket is decided from. Deliberately not GraphicsOrder --
// the page maps into this, so the rules can be tested against plain objects
// and don't move when the Prisma include changes.
export interface TodayFacts {
  status: ArtworkOrderStatus;
  inHandDate: Date | null;
  material: string | null;
  graphicCode: string | null;
  // The show this piece is for, whether it came via the opportunity or
  // directly (a Hub/hanging-sign piece). Null means unscheduled.
  showStartDate: Date | null;
}

export interface UrgentItem<T> {
  order: T;
  sla: SlaStatus;
  // False when the turnaround behind `sla` was guessed from free text or
  // from no material at all -- the date is then an estimate, and the row
  // says so rather than presenting a guess as a deadline.
  turnaroundIsKnown: boolean;
}

export interface ApprovalItem<T> {
  order: T;
  // Business days until show-site setup. Negative once the show has
  // started.
  businessDaysToShow: number;
}

export interface WaitingItem<T> {
  order: T;
  waitingOn: WaitingOn;
  nextStep: string;
  showStartDate: Date | null;
}

export interface EscalatedItem<T> {
  order: T;
  // Null when the piece has no in-hand date to judge against.
  sla: SlaStatus | null;
}

export interface TodayBuckets<T> {
  // Hit the revision cap and can't move at all until someone decides
  // something. Ranked above every other bucket because none of them can
  // progress while this one is stuck -- an escalated piece that is also
  // late is still, first, escalated.
  escalated: EscalatedItem<T>[];
  // In-hand date already passed and the piece still isn't made.
  overdue: UrgentItem<T>[];
  // Not enough business days left for this material's standard turnaround,
  // so pulling it in may attract a rush charge. A warning to pass to the
  // AM/PM, never a price -- see RUSH_FEE_TIERS.
  rushRisk: UrgentItem<T>[];
  // Unapproved with the show already inside its 10-business-day approval
  // window.
  approvalWindow: ApprovalItem<T>[];
  // Everything else, split by whose move it is. Soonest show first.
  waitingOnUs: WaitingItem<T>[];
  waitingOnOthers: WaitingItem<T>[];
  // One number for the hero: everything in the three urgency buckets plus
  // everything sitting with us.
  needsYou: number;
}

// Sorts nulls last -- an unscheduled piece is not more urgent than a dated
// one, it just has no date to compare.
function byDateAscNullsLast(a: Date | null, b: Date | null): number {
  if (a && b) return a.getTime() - b.getTime();
  if (a) return -1;
  if (b) return 1;
  return 0;
}

// A piece appears in at most ONE urgency bucket, worst first, and a piece
// in an urgency bucket is not repeated in the waiting-on lists below it.
// The old dashboard listed the same overdue order in three places, which is
// what made it read as busier than the work actually was.
export function buildTodayBuckets<T>(
  orders: T[],
  read: (order: T) => TodayFacts,
  now: Date = new Date(),
): TodayBuckets<T> {
  const escalated: EscalatedItem<T>[] = [];
  const overdue: UrgentItem<T>[] = [];
  const rushRisk: UrgentItem<T>[] = [];
  const approvalWindow: ApprovalItem<T>[] = [];
  const waitingOnUs: WaitingItem<T>[] = [];
  const waitingOnOthers: WaitingItem<T>[] = [];

  for (const order of orders) {
    const facts = read(order);
    const waitingOn = WAITING_ON[facts.status];
    // Travelling or finished: nothing to chase, in any bucket.
    if (waitingOn === "NOBODY") continue;

    const sla = PRODUCTION_SETTLED.has(facts.status) ? null : slaStatus(facts, now);
    const turnaroundIsKnown = materialClassIsKnown(facts.material, facts.graphicCode);

    if (facts.status === "ESCALATED") {
      escalated.push({ order, sla });
      continue;
    }
    if (sla?.overdue) {
      overdue.push({ order, sla, turnaroundIsKnown });
      continue;
    }
    if (sla?.atRiskOfRushFee) {
      rushRisk.push({ order, sla, turnaroundIsKnown });
      continue;
    }

    if (PRE_APPROVAL.has(facts.status) && facts.showStartDate) {
      const businessDaysToShow = businessDaysBetween(now, facts.showStartDate);
      if (businessDaysToShow < APPROVAL_LEAD_BUSINESS_DAYS) {
        approvalWindow.push({ order, businessDaysToShow });
        continue;
      }
    }

    const item: WaitingItem<T> = {
      order,
      waitingOn,
      nextStep: NEXT_STEP[facts.status],
      showStartDate: facts.showStartDate,
    };
    if (waitingOn === "EXPO") waitingOnUs.push(item);
    else waitingOnOthers.push(item);
  }

  // Worst first within each urgency bucket: the piece with the least time
  // left is the one to look at. An escalated piece with no in-hand date
  // sorts last among escalations rather than first -- no date is not the
  // same as no time.
  escalated.sort((a, b) => {
    if (a.sla && b.sla) return a.sla.businessDaysRemaining - b.sla.businessDaysRemaining;
    if (a.sla) return -1;
    if (b.sla) return 1;
    return 0;
  });
  overdue.sort((a, b) => a.sla.businessDaysRemaining - b.sla.businessDaysRemaining);
  rushRisk.sort((a, b) => a.sla.businessDaysRemaining - b.sla.businessDaysRemaining);
  approvalWindow.sort((a, b) => a.businessDaysToShow - b.businessDaysToShow);
  waitingOnUs.sort((a, b) => byDateAscNullsLast(a.showStartDate, b.showStartDate));
  waitingOnOthers.sort((a, b) => byDateAscNullsLast(a.showStartDate, b.showStartDate));

  return {
    escalated,
    overdue,
    rushRisk,
    approvalWindow,
    waitingOnUs,
    waitingOnOthers,
    needsYou:
      escalated.length + overdue.length + rushRisk.length + approvalWindow.length + waitingOnUs.length,
  };
}
