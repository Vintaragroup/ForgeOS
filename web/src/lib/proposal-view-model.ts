// Shared category-bucketing/aggregation logic for every place a proposal's
// line items get shown to a client -- the downloadable PDF
// (proposal-pdf.tsx) and the web-viewable proposal page
// (app/proposals/[id]/page.tsx). Previously each had its own independent
// copy of this logic (the web page's was explicitly commented "mirrors
// proposal-pdf.tsx"), which is exactly how they drifted: the PDF moved to
// category-based, cross-booth-aggregated grouping while the web page
// stayed on the older per-booth/detail-toggle rendering. One source of
// truth here; each caller does its own presentation (PDF vs HTML) on top
// of the same data shape.

import type { Category, Prisma } from "@/generated/prisma/client";
import type { SectionBuildType } from "@/generated/prisma/enums";
import {
  getCategoryChildren,
  isCompoundAssemblyDescription,
  leafCategoryKey,
  resolveCategoryNameFromKey,
  TYPE_KEYS_WITH_METHOD_SPLIT,
} from "@/lib/line-item-category";

export interface ProposalViewLineItem {
  id: string;
  description: string;
  category: string | null;
  isClientOwned: boolean;
  qty: Prisma.Decimal;
  unit: string | null;
  totalCost: Prisma.Decimal;
  sortOrder: number;
}

export interface ProposalViewSection {
  name: string;
  // The numbered booth/exhibit a pricing-schedule import split this
  // section out for (e.g. "Section 402 - Booth 1 - Page 8") -- see
  // pricing-import-service.ts's own groupLabel comment. Null for
  // booth-independent sections (Add-Ons, Show Services, an AI-proposed
  // scope section with no per-booth breakdown).
  groupLabel: string | null;
  // Rental Structures vs. Custom Components -- see
  // EstimateSection.buildType's own schema comment. Optional/null until
  // an estimator tags this booth; see resolveEffectiveCategory below for
  // what happens before/after that. Optional (not just nullable) so a
  // caller building a ProposalViewSection without any booth concept in
  // play at all (most call sites, and every existing test fixture) can
  // simply omit it -- resolveEffectiveCategory treats missing the same
  // as null.
  buildType?: SectionBuildType | null;
  lineItems: ProposalViewLineItem[];
}

// A booth/component's effective category for bucketing purposes. Once
// an estimator tags its build type (EstimateSection.buildType, via the
// Line Items tab's own tagging card), that tag supplies this item's
// acquisition Method ONLY -- Rental/Purchase/Custom Fabricated -- never
// its Type. The item's own Type (Structure/Flooring/Furniture/
// Audio-Visual/Misc/Custom Build/...) always resolves from its own
// already-persisted `category`, tagged or not. This is a deliberate
// fix, confirmed live as a real bug in the tag's earlier, cruder form:
// tagging a vendor Audio/Visual bid comparison as "Custom Build" used
// to force ALL of its line items -- including ~$50k of real Audio/
// Visual pricing -- into one Rental-Structures-or-Custom-Components
// bucket, discarding what they actually were. Now that same tag
// composes with each item's own Type instead, so those items land at
// "Audio/Visual - Rental" (or whichever Method was tagged) rather than
// disappearing into Structure/Custom Build.
//
// An untagged booth (buildType still null) falls through to the item's
// own raw category unchanged, same as before this composition existed.
// Shared by aggregateByCategory (PDF/web proposal) and the Line Items
// tab's own bucketLineItemsByCategory, so the two views can never
// resolve a booth's category differently.
export function resolveEffectiveCategory(
  li: { category: string | null },
  section: { groupLabel: string | null; buildType?: SectionBuildType | null },
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): string {
  const ownCategory = li.category ? categories.find((c) => c.name === li.category) : undefined;
  if (section.groupLabel && section.buildType && ownCategory) {
    // This item's own Type category: itself if it's already a top-level
    // Type (no parent -- e.g. Labor, Graphics, or an untagged Structure
    // item), or its parent if it's already a Method leaf (re-tagging a
    // booth that was tagged before, or an item whose own category was
    // hand-set to a leaf directly).
    const typeCategory = ownCategory.parentId
      ? categories.find((c) => c.id === ownCategory.parentId)
      : ownCategory;
    if (typeCategory && (TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(typeCategory.key)) {
      const resolved = resolveCategoryNameFromKey(categories, leafCategoryKey(typeCategory.key, section.buildType));
      if (resolved) return resolved;
    }
  }
  return ownCategory ? ownCategory.name : "Other";
}

export interface AggregatedLineItem {
  key: string;
  description: string;
  // The originating section's groupLabel, carried through only for a
  // compound assembly line (see isCompoundAssemblyDescription) -- a real,
  // one-off structure ("Complete Booth Build...") that a client needs to
  // know is Booth 402 vs Booth 203, not a catalog SKU where the booth
  // number is irrelevant once quantities are summed across the show.
  boothLabel: string | null;
  qty: number;
  unit: string | null;
  totalCost: number;
  // True only when every instance aggregated into this row is client-owned
  // -- a mixed group (one booth's client-supplied unit, another's Expo
  // rental of the same named part) shouldn't display as "Client Owned"
  // for the combined row.
  isClientOwned: boolean;
  // The minimum sortOrder among every raw instance merged into this row --
  // drives display order within the category (estimate page's drag board
  // sets sortOrder per raw LineItem; an aggregated row's position follows
  // whichever instance was dragged earliest/highest in that category).
  sortOrder: number;
}

export interface CategoryBucket {
  name: string;
  items: AggregatedLineItem[];
}

// The historical Expo CCI proposals consolidate a whole show's worth of
// booth-INDEPENDENT line items into one bill of materials per category --
// "B-MATRIX FRAMES - STANDARD, 34, $8,054.60" is a sum across every
// generic-rental section using that frame, not a per-booth breakdown.
// ForgeOS's estimate-editing UI still tracks line items per booth/section
// (useful for production/build tracking), and every client-facing view
// buckets by category and sums identical (description, unit) pairs --
// but ONLY within the same booth (EstimateSection.groupLabel) when one is
// known. A booth-independent line (no groupLabel -- Add-Ons, a generic
// catalog rental) still sums across the whole show, which is what fixes
// duplicate rows like the same compliant-door SKU appearing 16 times
// there. A booth-labeled line (a vendor-engineered booth workbook's own
// part, or a client-template's per-Section item) never merges across
// booths -- confirmed live, that used to collapse 13 physically distinct
// booths' pricing into one meaningless combined row.
//
// `categories` is the live catalog (db.category.findMany, ordered by
// sortOrder) -- both which names are valid (falling back to "Other" for
// anything else, e.g. a category since renamed/deleted out from under an
// old LineItem) and the bucket ordering come from it, not a hardcoded list.
export function aggregateByCategory(sections: ProposalViewSection[], categories: Category[]): CategoryBucket[] {
  const byCategory = new Map<string, Map<string, AggregatedLineItem>>();

  for (const section of sections) {
    for (const li of section.lineItems) {
      const category = resolveEffectiveCategory(li, section, categories);
      let bucket = byCategory.get(category);
      if (!bucket) {
        bucket = new Map();
        byCategory.set(category, bucket);
      }

      // A compound "Complete X Build" assembly is a unique physical
      // structure, never a catalog SKU repeated across booths -- two
      // booths can share the exact same spec text (a real job had two
      // identical "12' x 7' booth" camera booths at different unit
      // costs), so merging them by description+unit like every other
      // line would silently drop one booth's price into the other's qty.
      // Keyed by the line item's own id instead, and carries the
      // originating section's booth number through for display.
      //
      // Every OTHER line also stays scoped to its own booth whenever one
      // is known (section.groupLabel) -- confirmed live, a vendor-
      // engineered booth workbook (design-cost-estimate-import-service.ts)
      // never produces multi-line descriptions at all ("310mm x 2418mm
      // Frame", not "Complete Booth Build\n..."), so without this every
      // one of its part-level rows would fall through to the cross-show
      // merge below and get summed across all 13 booths into one
      // meaningless combined row -- exactly the "not separating builds"
      // bug this was built to fix. A groupLabel-less line (Add-Ons, a
      // generic catalog rental with no booth of its own) keeps the
      // original cross-show summing, which is still correct there: the
      // same door SKU appearing 16 times across booth-INDEPENDENT
      // sections really is one combined order, not 16 things to show
      // separately.
      const isAssembly = isCompoundAssemblyDescription(li.description);
      const boothScope = section.groupLabel ? `${section.groupLabel} ` : "";
      const key = isAssembly ? `assembly:${li.id}` : `${boothScope}${li.description} ${li.unit ?? ""}`;
      const existing = bucket.get(key);
      if (existing) {
        existing.qty += li.qty.toNumber();
        existing.totalCost += li.totalCost.toNumber();
        existing.isClientOwned = existing.isClientOwned && li.isClientOwned;
        existing.sortOrder = Math.min(existing.sortOrder, li.sortOrder);
      } else {
        bucket.set(key, {
          key,
          description: li.description,
          boothLabel: section.groupLabel,
          qty: li.qty.toNumber(),
          unit: li.unit,
          totalCost: li.totalCost.toNumber(),
          isClientOwned: li.isClientOwned,
          sortOrder: li.sortOrder,
        });
      }
    }
  }

  // "Other" is expected to already be one of the seeded categories (the
  // designated fallback bucket above) -- not appended separately here to
  // avoid a duplicate entry if it is.
  return categories
    .map((c) => c.name)
    .map((name) => {
      const items = [...(byCategory.get(name)?.values() ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);

      // Two physically-identical booths in the same numbered section (a
      // real job had two "12' x 7'" camera booths under "Section 203")
      // share both the exact same boothLabel and description -- otherwise
      // indistinguishable rows to a client reading the PDF. An ordinal is
      // the only way to tell them apart, same reasoning as the
      // estimate-editing page's groupLineItemsByBoothInstance.
      const dupeCounts = new Map<string, number>();
      for (const item of items) {
        if (!item.boothLabel) continue;
        const dupeKey = `${item.boothLabel}::${item.description}`;
        dupeCounts.set(dupeKey, (dupeCounts.get(dupeKey) ?? 0) + 1);
      }
      const seen = new Map<string, number>();
      for (const item of items) {
        if (!item.boothLabel) continue;
        const dupeKey = `${item.boothLabel}::${item.description}`;
        const total = dupeCounts.get(dupeKey)!;
        if (total <= 1) continue;
        const index = (seen.get(dupeKey) ?? 0) + 1;
        seen.set(dupeKey, index);
        item.boothLabel = `${item.boothLabel} — Booth ${index} of ${total}`;
      }

      return { name, items };
    })
    .filter((bucket) => bucket.items.length > 0);
}

export function bucketSubtotal(items: AggregatedLineItem[]): number {
  return items.reduce((sum, li) => sum + li.totalCost, 0);
}

export interface TopLevelCategoryView {
  name: string;
  ownItems: AggregatedLineItem[];
  children: CategoryBucket[];
  totalWithChildren: number;
}

// Only categories with no parent (Category.parentId null) render as
// their own top-level section -- a child category (Structure) renders
// nested under its parent instead, even when the parent bucket has no
// direct items of its own (e.g. Custom Build items exist only as
// Structure's children). `categories` drives both membership and order,
// same as aggregateByCategory.
export function buildTopLevelCategoryViews(buckets: CategoryBucket[], categories: Category[]): TopLevelCategoryView[] {
  const bucketsByName = new Map(buckets.map((b) => [b.name, b] as const));

  return categories
    .filter((c) => !c.parentId)
    .map((c) => c.name)
    .filter(
      (name) =>
        bucketsByName.has(name) || getCategoryChildren(categories, name).some((child) => bucketsByName.has(child.name)),
    )
    .map((name) => {
      const ownItems = bucketsByName.get(name)?.items ?? [];
      const children = getCategoryChildren(categories, name)
        .map((child) => bucketsByName.get(child.name))
        .filter((b): b is CategoryBucket => !!b);
      const totalWithChildren = bucketSubtotal(ownItems) + children.reduce((sum, child) => sum + bucketSubtotal(child.items), 0);
      return { name, ownItems, children, totalWithChildren };
    });
}

// A vendor-engineered booth workbook's own raw banner-row category
// ("BeMatrix", "Wall Panels", ...) -- the same raw text
// design-cost-estimate-import-service.ts writes as EstimateSection.name
// (findOrCreateSection's own `name: group.category`), carried through
// unchanged as ProposalViewSection.name. Deliberately NOT the same
// mapping as line-item-category.ts's mapDesignCostCategoryToCanonical:
// that one collapses BeMatrix and Wall Panels into one canonical
// "Structure" (correct for the estimate-editing UI/Review-tab audits/
// reconciliation, which only care about the client-facing proposal
// taxonomy), but a client reading a "Custom Rental" build-out wants the
// wall STRUCTURE (BeMatrix frames) kept visually distinct from the wall
// COVERING (SEG fabric panels) -- this is PDF-presentation-only, not a
// second categorization system, so it lives here rather than in
// line-item-category.ts.
const ELEMENT_TYPE_MAP: Record<string, string> = {
  "bematrix": "Wall Structure",
  "bematrix accessories": "Hardware",
  "wall panels": "Wall Covering",
  "graphic panels": "Graphics",
  "labor:": "Labor",
  "local transportation / material handling:": "Shipping",
};
// Natural build sequence (frame first, then what covers it, then
// graphics/labor/shipping), not alphabetical -- an unmapped raw category
// (e.g. "Flooring", "Electrical", "Cleaning" -- present in the template's
// own banner set but empty in every real file seen so far) falls back to
// its own raw text rather than being dropped, appended after the known
// ones in whatever order first encountered.
const ELEMENT_TYPE_ORDER = ["Wall Structure", "Hardware", "Wall Covering", "Graphics", "Labor", "Shipping"];

// Exported so the Line Items tab's own booth/component grouping
// (groupBoothLineItemsForEditing below) shares this exact mapping instead
// of duplicating it -- the editing view and the client-facing PDF should
// never disagree about what a raw section name means.
export function elementTypeForSection(sectionName: string): string {
  return ELEMENT_TYPE_MAP[sectionName.trim().toLowerCase()] ?? sectionName;
}

export interface ElementTypeGroup {
  elementType: string;
  items: AggregatedLineItem[];
  subtotal: number;
}

export interface BoothGroup {
  boothLabel: string;
  elementGroups: ElementTypeGroup[];
  subtotal: number;
}

// Companion to aggregateByCategory, not a replacement -- reads sections
// directly rather than that function's own output, because
// aggregateByCategory's merge key already collapsed BeMatrix and Wall
// Panels into one canonical "Structure" bucket (correct for its own
// purpose), discarding exactly the raw-category distinction this needs.
// Only sections with a known booth (groupLabel) contribute -- a
// booth-independent section (Add-Ons, a generic catalog rental, an
// AI-proposed scope item) has no booth to group by and isn't part of
// this "Custom Rental" build-out view at all; the caller renders those
// separately, unchanged, via aggregateByCategory as before.
export function groupBoothLineItems(sections: ProposalViewSection[]): BoothGroup[] {
  const byBooth = new Map<string, Map<string, Map<string, AggregatedLineItem>>>();

  for (const section of sections) {
    if (!section.groupLabel) continue;
    const boothLabel = section.groupLabel;
    const elementType = elementTypeForSection(section.name);

    let byElementType = byBooth.get(boothLabel);
    if (!byElementType) {
      byElementType = new Map();
      byBooth.set(boothLabel, byElementType);
    }
    let bucket = byElementType.get(elementType);
    if (!bucket) {
      bucket = new Map();
      byElementType.set(elementType, bucket);
    }

    for (const li of section.lineItems) {
      // Same reasoning as aggregateByCategory's own key: a compound
      // assembly is a unique physical structure, keyed by its own id so
      // two assemblies with identical spec text never silently merge.
      const isAssembly = isCompoundAssemblyDescription(li.description);
      const key = isAssembly ? `assembly:${li.id}` : `${li.description} ${li.unit ?? ""}`;
      const existing = bucket.get(key);
      if (existing) {
        existing.qty += li.qty.toNumber();
        existing.totalCost += li.totalCost.toNumber();
        existing.isClientOwned = existing.isClientOwned && li.isClientOwned;
        existing.sortOrder = Math.min(existing.sortOrder, li.sortOrder);
      } else {
        bucket.set(key, {
          key,
          description: li.description,
          boothLabel: null, // redundant once the booth is already the group's own heading
          qty: li.qty.toNumber(),
          unit: li.unit,
          totalCost: li.totalCost.toNumber(),
          isClientOwned: li.isClientOwned,
          sortOrder: li.sortOrder,
        });
      }
    }
  }

  const elementTypeRank = (name: string) => {
    const i = ELEMENT_TYPE_ORDER.indexOf(name);
    return i === -1 ? ELEMENT_TYPE_ORDER.length : i;
  };

  return [...byBooth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([boothLabel, byElementType]) => {
      const elementGroups = [...byElementType.entries()]
        .sort(([a], [b]) => elementTypeRank(a) - elementTypeRank(b))
        .map(([elementType, bucket]) => {
          const items = [...bucket.values()].sort((a, b) => a.sortOrder - b.sortOrder);
          return { elementType, items, subtotal: bucketSubtotal(items) };
        })
        // A section contributes an (elementType, bucket) entry the
        // moment it's seen, before any of its line items are known to
        // survive -- on a real job, several booths were still 100%
        // draft (excluded upstream by the PDF route's own isDraft:
        // false query), leaving an empty header with a $0.00 subtotal
        // and nothing under it. Confirmed live as exactly the "groups
        // but no details" report this filter fixes.
        .filter((g) => g.items.length > 0);
      if (elementGroups.length === 0) return null;
      const subtotal = elementGroups.reduce((sum, g) => sum + g.subtotal, 0);
      return { boothLabel, elementGroups, subtotal };
    })
    .filter((g): g is BoothGroup => g !== null);
}

// Generalizes the booth-grouped build-out view from the old two hardcoded
// buckets (Rental Structures / Custom Components) to one bucket per
// category a tagged booth's items actually resolve to -- reusing
// resolveEffectiveCategory itself, item by item, so the grouping can
// never disagree with aggregateByCategory's own flat bucketing (same
// resolved name is the map key both sides use). This is what lets one
// physical booth's Structure content and its Audio/Visual content each
// surface under their own category tab instead of one crowding out the
// other -- confirmed live as the exact bug that hid ~$50k of real
// Audio/Visual pricing under "Custom Components" on a real job, back
// when a tag forced an entire booth into one of two buckets regardless
// of what its line items actually were.
export function boothGroupsByCategory(
  sections: ProposalViewSection[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): Map<string, BoothGroup[]> {
  const sectionsByCategoryName = new Map<string, ProposalViewSection[]>();
  for (const section of sections) {
    if (!section.groupLabel || !section.buildType) continue;
    const itemsByCategoryName = new Map<string, ProposalViewLineItem[]>();
    for (const li of section.lineItems) {
      const categoryName = resolveEffectiveCategory(li, section, categories);
      const bucket = itemsByCategoryName.get(categoryName);
      if (bucket) bucket.push(li);
      else itemsByCategoryName.set(categoryName, [li]);
    }
    for (const [categoryName, items] of itemsByCategoryName) {
      const clone: ProposalViewSection = { ...section, lineItems: items };
      const arr = sectionsByCategoryName.get(categoryName);
      if (arr) arr.push(clone);
      else sectionsByCategoryName.set(categoryName, [clone]);
    }
  }
  const result = new Map<string, BoothGroup[]>();
  for (const [categoryName, sectionsForCategory] of sectionsByCategoryName) {
    result.set(categoryName, groupBoothLineItems(sectionsForCategory));
  }
  return result;
}

export interface RawElementTypeGroup<T> {
  elementType: string;
  items: T[];
  subtotal: number;
}

export interface RawBoothGroup<T> {
  boothLabel: string;
  elementGroups: RawElementTypeGroup<T>[];
  subtotal: number;
}

// Same booth -> element-type structure as groupBoothLineItems above, but
// for an editing surface (the Line Items tab's own "Components" view):
// every raw line item stays its own row -- own id, own move/edit/delete
// actions via LineItemRow -- instead of being merged by description+unit
// like the client-facing PDF's read-only version. Generic over T so a
// caller's own, richer LineItem shape (unitCost, isDraft, category, ...)
// passes straight through unchanged; this only ever needs `totalCost` (a
// Decimal, for subtotal math) and `sortOrder` (for display order) off it.
export function groupBoothLineItemsForEditing<T extends { totalCost: Prisma.Decimal; sortOrder: number }>(
  sections: { name: string; groupLabel: string | null; lineItems: T[] }[],
): RawBoothGroup<T>[] {
  const byBooth = new Map<string, Map<string, T[]>>();

  for (const section of sections) {
    if (!section.groupLabel) continue;
    const boothLabel = section.groupLabel;
    const elementType = elementTypeForSection(section.name);

    let byElementType = byBooth.get(boothLabel);
    if (!byElementType) {
      byElementType = new Map();
      byBooth.set(boothLabel, byElementType);
    }
    let bucket = byElementType.get(elementType);
    if (!bucket) {
      bucket = [];
      byElementType.set(elementType, bucket);
    }
    bucket.push(...section.lineItems);
  }

  const elementTypeRank = (name: string) => {
    const i = ELEMENT_TYPE_ORDER.indexOf(name);
    return i === -1 ? ELEMENT_TYPE_ORDER.length : i;
  };

  return [...byBooth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([boothLabel, byElementType]) => {
      const elementGroups = [...byElementType.entries()]
        .sort(([a], [b]) => elementTypeRank(a) - elementTypeRank(b))
        .map(([elementType, items]) => {
          const sorted = [...items].sort((a, b) => a.sortOrder - b.sortOrder);
          const subtotal = sorted.reduce((sum, li) => sum + li.totalCost.toNumber(), 0);
          return { elementType, items: sorted, subtotal };
        })
        // Same reasoning as groupBoothLineItems' own filter above -- an
        // all-draft section still creates an (elementType, bucket) entry
        // before any items are known to survive.
        .filter((g) => g.items.length > 0);
      if (elementGroups.length === 0) return null;
      const subtotal = elementGroups.reduce((sum, g) => sum + g.subtotal, 0);
      return { boothLabel, elementGroups, subtotal };
    })
    .filter((g): g is RawBoothGroup<T> => g !== null);
}

// Editing-surface counterpart to boothGroupsByCategory above -- same
// per-item Type+Method resolution (resolveEffectiveCategory), same
// per-category grouping, but keeps every raw line item its own row via
// groupBoothLineItemsForEditing instead of merging by description+unit.
// Generic over T for the same reason groupBoothLineItemsForEditing is:
// the Line Items tab's own richer LineItem shape (unitCost, isDraft, ...)
// passes straight through unchanged.
export function boothGroupsByCategoryForEditing<
  T extends { totalCost: Prisma.Decimal; sortOrder: number; category: string | null },
>(
  sections: { name: string; groupLabel: string | null; buildType?: SectionBuildType | null; lineItems: T[] }[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): Map<string, RawBoothGroup<T>[]> {
  const sectionsByCategoryName = new Map<string, { name: string; groupLabel: string | null; lineItems: T[] }[]>();
  for (const section of sections) {
    if (!section.groupLabel || !section.buildType) continue;
    const itemsByCategoryName = new Map<string, T[]>();
    for (const li of section.lineItems) {
      const categoryName = resolveEffectiveCategory(li, section, categories);
      const bucket = itemsByCategoryName.get(categoryName);
      if (bucket) bucket.push(li);
      else itemsByCategoryName.set(categoryName, [li]);
    }
    for (const [categoryName, items] of itemsByCategoryName) {
      const clone = { name: section.name, groupLabel: section.groupLabel, lineItems: items };
      const arr = sectionsByCategoryName.get(categoryName);
      if (arr) arr.push(clone);
      else sectionsByCategoryName.set(categoryName, [clone]);
    }
  }
  const result = new Map<string, RawBoothGroup<T>[]>();
  for (const [categoryName, sectionsForCategory] of sectionsByCategoryName) {
    result.set(categoryName, groupBoothLineItemsForEditing(sectionsForCategory));
  }
  return result;
}

export function computeRentalAndServicesTotals(
  buckets: CategoryBucket[],
  showServicesCategories: ReadonlySet<string>,
): { rentalTotal: number; servicesTotal: number; hasServiceSplit: boolean } {
  const rentalTotal = buckets
    .filter((b) => !showServicesCategories.has(b.name))
    .reduce((sum, b) => sum + bucketSubtotal(b.items), 0);
  const servicesTotal = buckets
    .filter((b) => showServicesCategories.has(b.name))
    .reduce((sum, b) => sum + bucketSubtotal(b.items), 0);
  const hasServiceSplit = buckets.some((b) => showServicesCategories.has(b.name));
  return { rentalTotal, servicesTotal, hasServiceSplit };
}
