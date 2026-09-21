// Miami Graphics' print shops, and the rules for reconciling them with
// the vendors ForgeOS already has.
//
// ForgeOS's vendor table was built from the PGA (Orlando) control log, so
// it holds 7 Orlando shops. Gabriella's Microsoft List carries a much
// larger controlled vocabulary covering Miami, California, Vegas, Utah and
// New York. Those two lists overlap in about three places and spell the
// overlap differently.
//
// The names below are hers, exactly as her list stores them -- including
// "Binick Imaginig" and "Sir Speed Signs", which are misspellings in the
// source. Matching an import means matching what the export actually
// contains, so the stored spelling stays hers and any correction belongs
// in a display name later, not here.

// Two entries in her Shop column are not vendors at all:
//
//   "Expo"    -- produced in-house. Only possible at an office with a sign
//                shop, which today means Miami.
//   "AE / PM" -- the Account/Project Manager coordinates the printing
//                themselves against their own local shops. "AE" is the old
//                title for Account Manager; she has confirmed the current
//                wording is AM/PM.
//
// Both are routing outcomes rather than companies, so neither becomes a
// Vendor row. They are handled by the routing model (A3).
export const NON_VENDOR_SHOPS = ["Expo", "AE / PM", "AM/PM", "AM / PM"] as const;

export interface GraphicsVendorSeed {
  // Exactly as her list spells it -- this is the import match key.
  name: string;
  // Short code for the dense Production Hub tables, matching the existing
  // Vendor.initials convention ("SPEEDPRO", "OLFP").
  initials: string;
  // Whether this shop appears in the Seatrade April 2026 export, which is
  // the only complete show we have. A configured option nobody used is
  // still worth creating -- a later show will reach for it -- but it is
  // worth knowing which ones are live.
  seenInUse: boolean;
}

// Her configured Shop list. `seenInUse` reflects the Seatrade April 2026
// export: of ~20 configured outside shops, only 7 were actually used on a
// 282-piece show.
export const GRAPHICS_VENDOR_SEEDS: GraphicsVendorSeed[] = [
  { name: "A3Visual - Miami/Cali/Vegas", initials: "A3VISUAL", seenInUse: true },
  { name: "Binick Imaginig - Miami", initials: "BINICK", seenInUse: true },
  { name: "Binca - Miami", initials: "BINCA", seenInUse: true },
  { name: "Procedes llc", initials: "PROCEDES", seenInUse: true },
  { name: "DTP - Vegas/Utah", initials: "DTP", seenInUse: true },
  { name: "Sir Speed Signs - Miami", initials: "SIRSPEED", seenInUse: true },
  { name: "Orbus - Orlando", initials: "ORBUS", seenInUse: true },
  { name: "Fusion - Orlando/Utah/Vegas", initials: "FUSION", seenInUse: false },
  { name: "The Printer's Consultant - Miami", initials: "PRINTERSCON", seenInUse: false },
  { name: "Expo Depot - New York", initials: "EXPODEPOT", seenInUse: false },
  { name: "5 Inc. - Utah", initials: "5INC", seenInUse: false },
  { name: "Image Options - CA", initials: "IMAGEOPTIONS", seenInUse: false },
  { name: "Ultimate Signs - Orlando", initials: "ULTIMATE", seenInUse: false },
  { name: "SuperColor Digital - Vegas", initials: "SUPERCOLOR", seenInUse: false },
  { name: "SpeedPro - Orlando", initials: "SPEEDPRO", seenInUse: false },
  { name: "Olympus - Orlando", initials: "OLYMPUS", seenInUse: false },
  { name: "FGS - Orlando", initials: "FGS", seenInUse: false },
  { name: "ALL IN - Vegas", initials: "ALLIN", seenInUse: false },
  { name: "Thomas Print Works - Orlando", initials: "THOMAS", seenInUse: false },
];

// Reduces a shop name to something comparable across the two lists.
// "Olympus - Orlando" and "Olympus Custom Print (ORLANDO)" have to land on
// the same vendor; "ORBUS" and "Orbus - Orlando" likewise.
//
// The location suffix is dropped because it describes where the shop has
// branches, not which Expo office uses it -- her own data spells the same
// shop as "ORBUS" on one row and "Orbus - Orlando" in the configured list.
export function normalizeVendorName(name: string): string {
  return name
    .toLowerCase()
    // Everything from the first " - " or " (" onward is a location tail.
    .split(/\s+-\s+|\s*\(/)[0]
    // Company-form words that differ between the two lists.
    .replace(/\b(llc|inc|incorporated|co|company|custom print|printing|signs?|imaging|imaginig)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

// A vendor row that is a person's name rather than a shop, or otherwise
// needs a human to look at it. Reported, never auto-merged or deleted.
export function looksLikeAPerson(name: string): boolean {
  const words = name.trim().split(/\s+/);
  if (words.length !== 2) return false;
  // Two capitalised words, no company-form token and no location tail.
  return words.every((w) => /^[A-Z][a-z]+$/.test(w));
}
