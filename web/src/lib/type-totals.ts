// Production/inventory pull-quantity rollup -- "how many of this exact
// physical part do we need across the whole show," not client-facing
// pricing. Distinct from proposal-view-model.ts's aggregateByCategory,
// which deliberately keeps a booth's items scoped to their own booth so a
// client sees each booth's own pricing distinctly -- this instead merges a
// repeated part's quantity across every booth/section in the estimate,
// since production needs one combined pull count, not a per-booth split.
// Reuses resolveEffectiveCategory/resolveComposedMethod and
// isCompoundAssemblyDescription so this can never disagree with how the
// Line Items board or the Proposal PDF categorize/identify the same item.

import type { Category, Prisma } from "@/generated/prisma/client";
import type { LineItemType, SectionBuildType } from "@/generated/prisma/enums";
import { isCompoundAssemblyDescription, leafCategoryKey, resolveAcquisitionMethod, TYPE_KEYS_WITH_METHOD_SPLIT } from "@/lib/line-item-category";
import { resolveComposedMethod, resolveEffectiveCategory } from "@/lib/proposal-view-model";

// Only two states for this report -- per direct confirmation, "pull from
// inventory" means Rental specifically (drawn from a shared rental pool);
// everything else has to be bought one way or another, including raw
// fabrication inputs (plywood, aluminum, hardware) that never carry a
// Method tag at all under the flat "Custom Build" category. So Purchase
// here also absorbs what the rest of the app calls Custom Fabricated --
// this report only distinguishes "pull from our stock" vs. "buy it."
export type PullMethod = "RENTAL" | "PURCHASE";

// Same static reverse map as proposal-view-model.ts's own
// LEAF_KEY_TO_TYPE_KEY, but keyed to the Method a leaf's key encodes
// instead of its Type -- lets an item whose own category was directly
// hand-set to a leaf (e.g. via the category board's "Move section", or a
// bulk move to "Structure - Rental") count as an explicit Method signal,
// not just a booth tag.
const LEAF_KEY_TO_METHOD = new Map<string, SectionBuildType>(
  (TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).flatMap((typeKey) =>
    (["RENTAL", "PURCHASE", "CUSTOM_BUILD"] satisfies SectionBuildType[]).map(
      (buildType) => [leafCategoryKey(typeKey, buildType), buildType] as const,
    ),
  ),
);

// A booth's own explicit tag wins outright when it applies to this item's
// Type (resolveComposedMethod -- the same eligibility resolveEffectiveCategory
// itself checks): a real, explicit estimator decision. Next, an item whose
// own category is itself a Method leaf (LEAF_KEY_TO_METHOD) -- also an
// explicit, deliberate choice, just made directly on the item instead of
// the whole booth. Only after both of those come up empty does this fall
// back to a description-only heuristic (resolveAcquisitionMethod) -- e.g.
// "bematrix" or explicit "rental" text in the description still reads as
// Rental even on an untagged booth. Deliberately description-only, never
// passing the item's own resolved `category` name into that heuristic: a
// flat category's display name can itself contain a Method-sounding word
// for unrelated historical reasons (the seeded "Custom Build / Rental"
// flat category, for one -- confirmed live: every item under it was
// misclassified as Rental purely because its own category name contains
// the word "Rental", not because any of them actually were). Anything
// left with no signal at all defaults to Purchase, per direct
// confirmation -- unclear means "it has to be bought," not "assume
// there's rental stock for it."
function resolvePullMethod(
  li: { category: string | null; description: string },
  section: { groupLabel: string | null; buildType?: SectionBuildType | null },
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): PullMethod {
  const taggedMethod = resolveComposedMethod(li, section, categories);
  if (taggedMethod) return taggedMethod === "RENTAL" ? "RENTAL" : "PURCHASE";

  const ownCategory = li.category ? categories.find((c) => c.name === li.category) : undefined;
  const leafMethod = ownCategory ? LEAF_KEY_TO_METHOD.get(ownCategory.key) : undefined;
  if (leafMethod) return leafMethod === "RENTAL" ? "RENTAL" : "PURCHASE";

  const inferred = resolveAcquisitionMethod({ description: li.description });
  return inferred === "RENTAL" ? "RENTAL" : "PURCHASE";
}

export interface PartQuantity {
  // method + description+unit for a normal repeatable part (merge key
  // across the whole estimate, scoped by method so e.g. a rented platform
  // and a custom-fabricated one with the same description never merge);
  // "assembly:<id>" for a compound assembly, which never merges with
  // another instance even if the text is identical -- same reasoning as
  // aggregateByCategory's own assembly key.
  key: string;
  description: string;
  unit: string | null;
  qty: number;
  totalCost: number;
  method: PullMethod;
}

// Per direct confirmation: "how many frames total, no matter the size" --
// a size-specific part row (e.g. "2418mm x 310mm Frame") is still the same
// physical family as "614mm x 2418mm Frame" for a combined pull count,
// even though they're two different SKUs above. Matched by keyword against
// the raw description (order matters, most specific first -- same
// convention as line-item-category.ts's own DESCRIPTION_PATTERNS), not by
// a rigid "last word" parse: that would wrongly split "Compliant Door -
// with Key" from "Compliant Door - with Code Keypad" into two families
// (last word "Key" vs "Keypad") when both are plainly doors. A description
// matching none of these stays out of every family total -- this seed list
// only covers the part types confirmed so far (Frame, Accessories, Door,
// SEG/Graphics); extend it as more come up rather than guessing at a name.
//
// trackSqft (SEG/Graphics only, per direct confirmation): this family also
// needs total square footage, not just a panel count -- see
// computeSqftForPart below for how that's derived per part.
const PART_FAMILY_PATTERNS: { pattern: RegExp; label: string; trackSqft?: boolean }[] = [
  { pattern: /\bframes?\b/i, label: "Frame" },
  { pattern: /\baccessor(?:y|ies)\b/i, label: "Accessories" },
  { pattern: /\bdoors?\b/i, label: "Door" },
  { pattern: /\bseg\b|\bgraphics?\b/i, label: "SEG/Graphics", trackSqft: true },
];

export function resolvePartFamily(description: string): { label: string; trackSqft?: boolean } | null {
  for (const { pattern, label, trackSqft } of PART_FAMILY_PATTERNS) {
    if (pattern.test(description)) return { label, trackSqft };
  }
  return null;
}

// A whole number optionally followed by a mixed fraction (e.g. "168",
// "15/16", or "168 15/16") -- the real, observed dimension-string
// convention for a fabric/graphic panel's cut size (confirmed live: "SEG
// w/ Blackout White - 168 15/16" x 95 1/16""), same fraction notation a
// shop tape measure reads in.
function parseInchesToken(token: string): number {
  const [wholePart, fractionPart] = token.trim().split(/\s+/);
  const whole = Number(wholePart);
  if (!fractionPart) return whole;
  const [numerator, denominator] = fractionPart.split("/").map(Number);
  return whole + numerator / denominator;
}

// Requires a literal `"` after EACH number -- deliberately, so this can
// never misread a millimeter dimension (e.g. "2418mm x 310mm Frame", the
// BeMatrix aluminum-profile convention) as inches. A description with no
// inch-marked WxH pair simply doesn't contribute an area -- consistent
// with this file's "don't guess" posture elsewhere (see e.g.
// resolvePullMethod's own comment), not a best-effort parse.
const INCH_DIMENSION_PATTERN = /(\d+(?:\s+\d+\/\d+)?)\s*"\s*x\s*(\d+(?:\s+\d+\/\d+)?)\s*"/i;

const SQFT_UNIT_PATTERN = /^sq\.?\s*ft\.?$/i;

// Two independent, real signals for a panel's area, per direct
// confirmation that "panel count" and "total square feet" need to both be
// available: (1) the line's own unit is already SQFT (qty IS the area,
// e.g. a consolidated "168 SQFT of SEG material" row -- no dimension
// parsing needed or possible), or (2) the description carries an explicit
// inch-marked WxH pair for an individually-counted panel (unit EA, qty =
// panel count), area = (W * H / 144) per panel * qty. Returns undefined
// (not 0) when neither signal is present, so a family's totalSqft only
// ever reflects rows it could actually measure, never a false "0 sqft."
function computeSqftForPart(part: { unit: string | null; description: string; qty: number }): number | undefined {
  if (part.unit && SQFT_UNIT_PATTERN.test(part.unit.trim())) return part.qty;
  const match = INCH_DIMENSION_PATTERN.exec(part.description);
  if (!match) return undefined;
  const width = parseInchesToken(match[1]);
  const height = parseInchesToken(match[2]);
  return ((width * height) / 144) * part.qty;
}

export interface PartFamilyTotal {
  label: string;
  qty: number;
  totalCost: number;
  // Only present for an area-tracked family (SEG/Graphics) -- undefined,
  // not 0, when none of its parts had a measurable area (see
  // computeSqftForPart).
  totalSqft?: number;
}

export interface MethodTotal {
  totalCost: number;
  parts: PartQuantity[];
  // Only families with at least one matching, non-assembly part -- sorted
  // alphabetically by label. See resolvePartFamily.
  families: PartFamilyTotal[];
}

export interface TypeTotal {
  categoryName: string;
  totalCost: number;
  rental: MethodTotal;
  purchase: MethodTotal;
}

// Only MATERIAL lines are physical units pulled from inventory -- Labor and
// Fee lines have no qty-to-pull meaning. isDraft (not yet human-reviewed/
// priced) and isClientOwned (the client supplies it themselves, nothing to
// pull from our own stock) are excluded for the same reason cost rollups
// elsewhere already exclude them.
export function buildTypeTotals<
  T extends {
    id: string;
    lineType: LineItemType;
    description: string;
    category: string | null;
    unit: string | null;
    qty: Prisma.Decimal;
    totalCost: Prisma.Decimal;
    isDraft: boolean;
    isClientOwned: boolean;
  },
>(
  sections: { groupLabel: string | null; buildType?: SectionBuildType | null; lineItems: T[] }[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): TypeTotal[] {
  const byCategory = new Map<string, Map<string, PartQuantity>>();

  for (const section of sections) {
    for (const li of section.lineItems) {
      if (li.lineType !== "MATERIAL" || li.isDraft || li.isClientOwned) continue;

      const categoryName = resolveEffectiveCategory(li, section, categories);
      const method = resolvePullMethod(li, section, categories);
      let parts = byCategory.get(categoryName);
      if (!parts) {
        parts = new Map();
        byCategory.set(categoryName, parts);
      }

      // A compound assembly is a unique physical structure, never a
      // repeatable catalog part -- keyed by a synthetic per-instance id so
      // two assemblies with identical spec text never silently merge into
      // one bogus combined quantity, same reasoning as
      // aggregateByCategory's own isAssembly branch.
      const isAssembly = isCompoundAssemblyDescription(li.description);
      const key = isAssembly ? `assembly:${li.id}` : `${method}:${li.description} ${li.unit ?? ""}`;
      const existing = parts.get(key);
      if (existing) {
        existing.qty += li.qty.toNumber();
        existing.totalCost += li.totalCost.toNumber();
      } else {
        parts.set(key, {
          key,
          description: li.description,
          unit: li.unit,
          qty: li.qty.toNumber(),
          totalCost: li.totalCost.toNumber(),
          method,
        });
      }
    }
  }

  function methodTotal(parts: PartQuantity[], method: PullMethod): MethodTotal {
    const filtered = parts.filter((p) => p.method === method).sort((a, b) => a.description.localeCompare(b.description));

    // Rolled up from these same already-computed parts (not re-scanned from
    // raw line items), so a family's total always matches the sum of its
    // own size-specific rows below it. A compound assembly (key starts
    // "assembly:") never contributes -- it's a one-off structure, not a
    // repeatable part, even if its long narrative description happens to
    // contain a family keyword incidentally.
    const familiesByLabel = new Map<string, PartFamilyTotal>();
    for (const part of filtered) {
      if (part.key.startsWith("assembly:")) continue;
      const family = resolvePartFamily(part.description);
      if (!family) continue;
      const sqft = family.trackSqft ? computeSqftForPart(part) : undefined;
      const existing = familiesByLabel.get(family.label);
      if (existing) {
        existing.qty += part.qty;
        existing.totalCost += part.totalCost;
        if (sqft !== undefined) existing.totalSqft = (existing.totalSqft ?? 0) + sqft;
      } else {
        familiesByLabel.set(family.label, { label: family.label, qty: part.qty, totalCost: part.totalCost, totalSqft: sqft });
      }
    }
    const families = [...familiesByLabel.values()].sort((a, b) => a.label.localeCompare(b.label));

    return { totalCost: filtered.reduce((sum, p) => sum + p.totalCost, 0), parts: filtered, families };
  }

  return categories
    .map((c) => c.name)
    .filter((name) => byCategory.has(name))
    .map((categoryName) => {
      const parts = [...byCategory.get(categoryName)!.values()];
      const rental = methodTotal(parts, "RENTAL");
      const purchase = methodTotal(parts, "PURCHASE");
      return { categoryName, totalCost: rental.totalCost + purchase.totalCost, rental, purchase };
    });
}
