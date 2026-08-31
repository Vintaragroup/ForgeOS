// Production/inventory pull-quantity rollup -- "how many of this exact
// physical part do we need across the whole show," not client-facing
// pricing. Distinct from proposal-view-model.ts's aggregateByCategory,
// which deliberately keeps a booth's items scoped to their own booth so a
// client sees each booth's own pricing distinctly -- this instead merges a
// repeated part's quantity across every booth/section in the estimate,
// since production needs one combined pull count, not a per-booth split.
// Reuses resolveEffectiveCategory and isCompoundAssemblyDescription so this
// can never disagree with how the Line Items board or the Proposal PDF
// categorize/identify the same item.

import type { Category, Prisma } from "@/generated/prisma/client";
import type { LineItemType, SectionBuildType } from "@/generated/prisma/enums";
import { isCompoundAssemblyDescription } from "@/lib/line-item-category";
import { resolveEffectiveCategory } from "@/lib/proposal-view-model";

export interface PartQuantity {
  // description+unit for a normal repeatable part (merge key across the
  // whole estimate); "assembly:<id>" for a compound assembly, which never
  // merges with another instance even if the text is identical -- same
  // reasoning as aggregateByCategory's own assembly key.
  key: string;
  description: string;
  unit: string | null;
  qty: number;
  totalCost: number;
}

export interface TypeTotal {
  categoryName: string;
  totalCost: number;
  parts: PartQuantity[];
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
      const key = isAssembly ? `assembly:${li.id}` : `${li.description} ${li.unit ?? ""}`;
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
        });
      }
    }
  }

  return categories
    .map((c) => c.name)
    .filter((name) => byCategory.has(name))
    .map((categoryName) => {
      const parts = [...byCategory.get(categoryName)!.values()].sort((a, b) => a.description.localeCompare(b.description));
      const totalCost = parts.reduce((sum, p) => sum + p.totalCost, 0);
      return { categoryName, totalCost, parts };
    });
}
