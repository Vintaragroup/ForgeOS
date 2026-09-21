// Reprints: why a piece was run again, and the one rule the SOP puts on
// recording it.
//
// A leaf module -- no db import -- so the picker and the validator share
// one list.

import type { ArtworkOrderType, ArtworkReprintReason } from "@/generated/prisma/enums";

export const REPRINT_REASONS: ArtworkReprintReason[] = [
  "PRODUCTION_QUALITY",
  "TRANSPORT_HANDLING_DAMAGE",
  "INSTALL_SITE_DAMAGE",
  "CLIENT_CHANGES",
  "NEW_ORDER_UPSELL",
  "OTHER",
];

// Worded as her list words them, so a coordinator reads the same options
// here as in the tracker.
export const REPRINT_REASON_LABELS: Record<ArtworkReprintReason, string> = {
  PRODUCTION_QUALITY: "Reprint - Production Quality",
  TRANSPORT_HANDLING_DAMAGE: "Reprint - Transport/Handling Damage",
  INSTALL_SITE_DAMAGE: "Reprint - Install/Site Damage",
  CLIENT_CHANGES: "Reprint - Client Changes",
  NEW_ORDER_UPSELL: "New Order (Upsell)",
  OTHER: "Other (Missing, Not Requested, etc)",
};

// Her tracker's exact strings, for mapping an export. Both the spelling in
// the configured list and the one the site-only export actually contains
// ("Not requested" vs "Not Requested") are accepted, because they differ.
const TRACKER_STRINGS: Record<string, ArtworkReprintReason> = {
  "reprint - production quality": "PRODUCTION_QUALITY",
  "reprint - transport/handling damage": "TRANSPORT_HANDLING_DAMAGE",
  "reprint - install/site damage": "INSTALL_SITE_DAMAGE",
  "reprint - client changes": "CLIENT_CHANGES",
  "new order (upsell)": "NEW_ORDER_UPSELL",
  "other (missing, not requested, etc)": "OTHER",
  "other (missing, not requested etc)": "OTHER",
};

export function reprintReasonFromTracker(raw: string | null | undefined): ArtworkReprintReason | null {
  const key = `${raw ?? ""}`.trim().toLowerCase().replace(/\s+/g, " ");
  return TRACKER_STRINGS[key] ?? null;
}

// NEW_ORDER_UPSELL sits in the reprint column but is not a reprint: it
// means the row is additional billable work, not a re-run of something
// already printed. Counting it as a reprint would make the department's
// quality numbers look worse than they are and hide the revenue.
export function isActualReprint(reason: ArtworkReprintReason | null): boolean {
  return reason !== null && reason !== "NEW_ORDER_UPSELL";
}

// Whether a reprint reason must be recorded. SOP Part 3: "Production
// tracker should also indicate reprint reason for all site prints."
export function reprintReasonRequired(orderType: ArtworkOrderType | null): boolean {
  return orderType === "SITE";
}

// The free-text note is required where the category alone explains
// nothing -- the same posture postShowConditionNote already takes for
// DAMAGED/AGING. "Other" without a sentence is an empty record.
export function reprintNoteRequired(reason: ArtworkReprintReason): boolean {
  return reason === "OTHER";
}
