// What kind of work an artwork order is, and the two rules that hang off
// it in the Graphics SOP.
//
// A leaf module -- no db import -- so a client component can label a
// picker with the same words the server validates against.

import type { ArtworkOrderType } from "@/generated/prisma/enums";

export const ARTWORK_ORDER_TYPES: ArtworkOrderType[] = ["EXHIBITOR", "SHOW_MANAGEMENT", "SITE"];

export const ARTWORK_ORDER_TYPE_LABELS: Record<ArtworkOrderType, string> = {
  EXHIBITOR: "Exhibitor booth",
  SHOW_MANAGEMENT: "Show management",
  SITE: "Show site",
};

// Her tracker spells these "EXH", "SM" and "Site". Kept as the import key
// so a tracker export maps without a lookup table elsewhere.
export const TRACKER_CODE_TO_TYPE: Record<string, ArtworkOrderType> = {
  EXH: "EXHIBITOR",
  SM: "SHOW_MANAGEMENT",
  SITE: "SITE",
};

export function orderTypeFromTrackerCode(raw: string | null | undefined): ArtworkOrderType | null {
  const key = `${raw ?? ""}`.trim().toUpperCase();
  return TRACKER_CODE_TO_TYPE[key] ?? null;
}

// SOP Step 2: "Site Orders are automatically approved unless stated
// otherwise." Site signage is Expo's own work for the venue -- there is no
// exhibitor to send a proof to, so it does not wait on a client approval
// the way a booth graphic does.
//
// Reported, not applied. Acting on it means changing where an order enters
// the pipeline, which is the procurement/status work (B4) rather than
// something to slip in behind a field addition.
export function isAutoApproved(orderType: ArtworkOrderType | null): boolean {
  return orderType === "SITE";
}

// Part 3 of the SOP: "Production tracker should also indicate reprint
// reason for all site prints." Required on site work, optional elsewhere
// -- which is why her export has a Reprint Reason on all 16 rows of a
// site-only view and none at all on the Seatrade export, which predates
// the column.
export function requiresReprintReason(orderType: ArtworkOrderType | null): boolean {
  return orderType === "SITE";
}
