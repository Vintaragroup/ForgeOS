// The routing vocabulary: which production statuses each kind of half can
// be in, what they are called, and which of them mean "finished".
//
// Split out of artwork-routing.ts, which imports `db`. A client component
// (the shop floor's per-half status picker) needs this table to render the
// right options, and importing it from there would pull Prisma into the
// browser bundle. Pure data and pure predicates only -- artwork-routing
// re-exports all of it, so existing callers are unaffected.

import type { ArtworkProductionStatus, ArtworkRoutingKind } from "@/generated/prisma/enums";

// Which production statuses each kind of half can legally be in. An
// in-house half is never "O.S Sent"; an outsourced half never just
// "Printing". Kept as data so the picker and the validator read the same
// list and cannot drift.
export const PRODUCTION_STATUSES_BY_KIND: Record<ArtworkRoutingKind, ArtworkProductionStatus[]> = {
  EXPO_IN_HOUSE: ["NOT_STARTED", "PRINTING", "COMPLETED", "CANCELLED"],
  VENDOR: [
    "OS_NOT_SENT",
    "OS_SENT",
    "OS_QUOTE_APPROVED",
    "OS_PROOF_APPROVED",
    "OS_RECEIVED",
    "OS_RECEIVED_PARTIALLY",
    "OS_DELIVERED_TO_SHOWSITE",
    "CANCELLED",
  ],
  // The account team is handling it against their own shops, so Expo only
  // knows whether it has landed.
  AM_PM_COORDINATED: ["NOT_STARTED", "COMPLETED", "CANCELLED"],
};

export const PRODUCTION_STATUS_LABELS: Record<ArtworkProductionStatus, string> = {
  NOT_STARTED: "Not printed",
  PRINTING: "Printing",
  COMPLETED: "Completed",
  OS_NOT_SENT: "O.S not sent",
  OS_SENT: "O.S sent",
  OS_QUOTE_APPROVED: "O.S quote approved",
  OS_PROOF_APPROVED: "O.S proof approved",
  OS_RECEIVED: "O.S received",
  OS_RECEIVED_PARTIALLY: "O.S received partially",
  OS_DELIVERED_TO_SHOWSITE: "O.S delivered to showsite",
  CANCELLED: "Cancelled",
};

// The status a half starts in, which differs by kind: an outsourced half
// begins life as "not yet sent to the shop", an in-house one as "not yet
// printed".
export function defaultProductionStatus(kind: ArtworkRoutingKind): ArtworkProductionStatus {
  return kind === "VENDOR" ? "OS_NOT_SENT" : "NOT_STARTED";
}

// A half is done when it can no longer move on its own. Used to tell
// whether a split piece is fully finished -- both halves, not one.
const SETTLED: ArtworkProductionStatus[] = ["COMPLETED", "OS_RECEIVED", "OS_DELIVERED_TO_SHOWSITE", "CANCELLED"];

export function isHalfSettled(status: ArtworkProductionStatus): boolean {
  return SETTLED.includes(status);
}

// Partial receipt counts as unsettled on purpose: "O.S Received
// Partially" is precisely the state that looks finished on a dashboard
// and is not, and it is the one that burns a show.
export function isFullyProduced(routings: { productionStatus: ArtworkProductionStatus }[]): boolean {
  return routings.length > 0 && routings.every((r) => isHalfSettled(r.productionStatus));
}

