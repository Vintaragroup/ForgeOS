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
import { getCategoryChildren, isKnownCategory } from "@/lib/line-item-category";

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
  lineItems: ProposalViewLineItem[];
}

export interface AggregatedLineItem {
  key: string;
  description: string;
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
// line items into one bill of materials per category -- "B-MATRIX FRAMES
// - STANDARD, 34, $8,054.60" is a sum across every booth using that
// frame, not a per-booth breakdown. ForgeOS's estimate-editing UI still
// tracks line items per booth/section (useful for production/build
// tracking), but every client-facing view flattens all of it, buckets by
// category, and sums identical (description, unit) pairs across every
// booth -- which is also what actually fixes duplicate rows like the
// same compliant-door SKU appearing 16 times, rather than just hiding
// the count.
//
// `categories` is the live catalog (db.category.findMany, ordered by
// sortOrder) -- both which names are valid (falling back to "Other" for
// anything else, e.g. a category since renamed/deleted out from under an
// old LineItem) and the bucket ordering come from it, not a hardcoded list.
export function aggregateByCategory(sections: ProposalViewSection[], categories: Category[]): CategoryBucket[] {
  const byCategory = new Map<string, Map<string, AggregatedLineItem>>();

  for (const section of sections) {
    for (const li of section.lineItems) {
      const category = isKnownCategory(categories, li.category) ? li.category! : "Other";
      let bucket = byCategory.get(category);
      if (!bucket) {
        bucket = new Map();
        byCategory.set(category, bucket);
      }

      const key = `${li.description} ${li.unit ?? ""}`;
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
    .map((name) => ({
      name,
      items: [...(byCategory.get(name)?.values() ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    }))
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
