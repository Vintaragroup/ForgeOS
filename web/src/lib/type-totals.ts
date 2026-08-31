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

export interface MethodTotal {
  totalCost: number;
  parts: PartQuantity[];
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
    return { totalCost: filtered.reduce((sum, p) => sum + p.totalCost, 0), parts: filtered };
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
