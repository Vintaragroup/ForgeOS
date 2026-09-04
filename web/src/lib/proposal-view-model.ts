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
  METHOD_KEY_LABELS,
  resolveCategoryNameFromKey,
  TYPE_KEYS_WITH_METHOD_SPLIT,
  type MethodKey,
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
  // Per-item Proposal PDF visibility -- see LineItem.includeInProposal's
  // own schema comment. Optional, same reasoning as buildType below:
  // undefined means visible (true), so every existing caller/test
  // fixture that predates this field keeps rendering exactly as before.
  includeInProposal?: boolean;
}

export interface ProposalViewSection {
  // A real EstimateSection id in every production caller (Prisma's
  // default full-row select always includes it) -- used only to scope a
  // summarized standalone section's own items to itself (see
  // standaloneSummaryGroupsByCategory below), never displayed. Optional
  // only so a test fixture built before this field existed still
  // type-checks; standaloneSummaryGroupsByCategory falls back to `name`
  // as its scoping key when absent, which is fine for a fixture that
  // never has two same-named summarized sections anyway.
  id?: string;
  name: string;
  // User-approved short heading override for a booth-INDEPENDENT
  // section's own flat H1 -- see EstimateSection.description's own schema
  // comment. Optional/undefined so every existing caller/test fixture
  // without this concept in play is unaffected; standaloneSummaryGroupsByCategory
  // falls back to the raw `name` when absent, same as boothDescription's
  // own fallback to boothLabel.
  description?: string | null;
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
  // Whole-group PDF visibility/order -- see EstimateSection's own schema
  // comments. Both optional, same reasoning as buildType above: undefined
  // means visible / default position (0), so an existing caller/test
  // fixture never has to be updated just because these fields exist.
  includeInProposal?: boolean;
  proposalSortOrder?: number;
  // A booth's own H2 group order -- see EstimateSection.sortOrder's own
  // schema comment and moveElementGroupOrder. Optional/undefined means
  // "not yet reordered," same 0 default as proposalSortOrder above.
  sortOrder?: number;
  // Whole-booth "hide the detail, keep the price" on the client-facing
  // PDF -- see EstimateSection.summarizeOnProposal's own schema comment.
  // Optional, same reasoning as includeInProposal above: undefined means
  // full detail (unaffected), so no existing caller/test fixture needs
  // updating just because this field exists.
  summarizeOnProposal?: boolean;
  // Real, useful estimating work that isn't real client scope (a vendor
  // rate comparison, a competitor-bid snapshot) -- see
  // EstimateSection.excludedFromTotals's own schema comment. Optional,
  // same reasoning as includeInProposal above: undefined means "real
  // scope, counted as normal."
  excludedFromTotals?: boolean;
  // User-approved short heading override for this booth's H1, shown in
  // place of the raw groupLabel -- see EstimateSection.boothDescription's
  // own schema comment. Optional/undefined (not just nullable) so an
  // existing caller/test fixture without any booth-heading concept in
  // play never has to change just because this field exists; groupBoothLineItems
  // below falls back to the raw boothLabel when it's absent, same as
  // before this field was read here at all.
  boothDescription?: string | null;
  // A few client-readable sentences shown on the Proposal PDF's booth
  // header, always -- see EstimateSection.boothSummary's own schema
  // comment.
  boothSummary?: string | null;
  // Same idea, one level down (this element group alone) -- see
  // EstimateSection.elementSummary's own schema comment.
  elementSummary?: string | null;
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

// Reverse of leafCategoryKey(typeKey, buildType) -- built once from the
// same two static inputs (TYPE_KEYS_WITH_METHOD_SPLIT, every
// SectionBuildType) rather than derived per-call from a category's own
// key by string-slicing, so this can never drift out of sync with
// leafCategoryKey's own composition.
const LEAF_KEY_TO_TYPE_KEY = new Map<string, string>(
  (TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).flatMap((typeKey) =>
    (["RENTAL", "PURCHASE", "CUSTOM_BUILD"] satisfies SectionBuildType[]).map(
      (buildType) => [leafCategoryKey(typeKey, buildType), typeKey] as const,
    ),
  ),
);

// Exported wrapper around LEAF_KEY_TO_TYPE_KEY so a caller outside this
// file (e.g. estimate-service.ts's per-category margin resolution) can
// find a Method leaf's Type parent without duplicating the reverse-map
// logic -- returns undefined when `key` is already a Type (or a flat,
// non-split category), not just when it's genuinely unknown.
export function resolveTypeKeyForCategoryKey(key: string): string | undefined {
  return LEAF_KEY_TO_TYPE_KEY.get(key);
}

// Whether a booth's tag (section.buildType) actually composes onto this
// item -- true only when the item's own Type key is one of the five with a
// real Method split (TYPE_KEYS_WITH_METHOD_SPLIT) and the section is
// tagged. Identified from the item's own stable `key` via
// LEAF_KEY_TO_TYPE_KEY, NOT its parentId -- confirmed necessary against
// real data, where a Type's own parentId can be non-null for a reason
// unrelated to this taxonomy (a category hand-edited in
// /catalog/categories; see groupPrimaryCategoryTabs' own comment for the
// same issue there). Trusting parentId here would misresolve that Type's
// own untagged items as if they were themselves a Method leaf of whatever
// category parentId happens to (wrongly) point to.
//
// Exported so a caller that needs the raw composed Method itself, not just
// the resulting category name (e.g. type-totals.ts's Rental-vs-Purchase
// classification for the production pull-quantity report), can reuse this
// exact eligibility check instead of re-deriving it.
export function resolveComposedMethod(
  li: { category: string | null },
  section: { groupLabel: string | null; buildType?: SectionBuildType | null },
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): SectionBuildType | null {
  const ownCategory = li.category ? categories.find((c) => c.name === li.category) : undefined;
  if (!section.groupLabel || !section.buildType || !ownCategory) return null;
  const typeKey = LEAF_KEY_TO_TYPE_KEY.get(ownCategory.key) ?? ownCategory.key;
  return (TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(typeKey) ? section.buildType : null;
}

export function resolveEffectiveCategory(
  li: { category: string | null },
  section: { groupLabel: string | null; buildType?: SectionBuildType | null },
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): string {
  const ownCategory = li.category ? categories.find((c) => c.name === li.category) : undefined;
  const composedMethod = resolveComposedMethod(li, section, categories);
  if (composedMethod && ownCategory) {
    // This item's own Type key: itself if it's already a Type (flat, or
    // one of the five with a real Method split), or the Type its own key
    // composes onto if it's already a Method leaf (re-tagging a booth
    // that was tagged before, or an item whose own category was hand-set
    // to a leaf directly).
    const typeKey = LEAF_KEY_TO_TYPE_KEY.get(ownCategory.key) ?? ownCategory.key;
    const resolved = resolveCategoryNameFromKey(categories, leafCategoryKey(typeKey, composedMethod));
    if (resolved) return resolved;
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
    if (section.includeInProposal === false) continue;
    if (section.excludedFromTotals) continue;
    // A summarized standalone section (groupLabel null, summarizeOnProposal
    // true) is ALSO rendered as its own lump-sum "booth" by
    // standaloneSummaryGroupsByCategory -- its own items still stay in
    // this flat pool too (so every total that sums over these buckets,
    // e.g. documentGrandTotal below, keeps including them, exactly like a
    // real tagged booth's items already do), but scoped to their own
    // section (never cross-merged with a different section's items the
    // way an ordinary booth-independent line still is -- see boothScope's
    // own comment) and boothLabel-tagged the same way, so proposal-pdf.tsx's
    // existing "skip whatever a booth group already covers" filter (an
    // item's own boothLabel truthiness) excludes them from the flat
    // itemized render there without a second, parallel exclusion list.
    const standaloneSummaryScope = !section.groupLabel && section.summarizeOnProposal
      ? `__standalone_summary_${section.id ?? section.name}`
      : null;
    for (const li of section.lineItems) {
      if (li.includeInProposal === false) continue;
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
      const boothScope = section.groupLabel ? `${section.groupLabel} ` : standaloneSummaryScope ? `${standaloneSummaryScope} ` : "";
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
          boothLabel: section.groupLabel ?? standaloneSummaryScope,
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

// Exported for section-heading-editor.tsx's own state machine: a mapped
// section (one of the 6 fixed banner categories above) keeps its current
// fixed label always, with no edit/AI-suggestion UI at all -- only the
// unmapped/fallback case is ever eligible for a custom description.
export function isMappedElementType(sectionName: string): boolean {
  return sectionName.trim().toLowerCase() in ELEMENT_TYPE_MAP;
}

export interface ElementTypeGroup {
  elementType: string;
  items: AggregatedLineItem[];
  subtotal: number;
  // Always-shown body text for this one element group -- see
  // EstimateSection.elementSummary's own schema comment. Null until an
  // estimator writes or approves one.
  elementSummary: string | null;
}

export interface BoothGroup {
  boothLabel: string;
  // The booth's own approved H1 heading override, when it has one --
  // see EstimateSection.boothDescription's own schema comment. Null
  // until an estimator writes or approves one, in which case the raw,
  // often-meaningless boothLabel (a pricing-schedule's own internal
  // groupLabel, e.g. "RENTAL") is what a viewer would otherwise see.
  // proposal-pdf.tsx and the web proposal page render this in place of
  // boothLabel whenever it's set -- neither field alone is enough on its
  // own: boothLabel is always present and is the merge/move-tool's own
  // key, boothDescription is the friendly text a person actually reads.
  boothDescription: string | null;
  elementGroups: ElementTypeGroup[];
  subtotal: number;
  // See EstimateSection.summarizeOnProposal's own schema comment --
  // proposal-pdf.tsx skips elementGroups' itemized rows entirely (never
  // the header or any of the summary text below) when this is true.
  summarizeOnProposal: boolean;
  // Always-shown body text for this booth's header -- see
  // EstimateSection.boothSummary's own schema comment. Null until an
  // estimator writes or approves one.
  boothSummary: string | null;
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
  // A booth's PDF position -- the min proposalSortOrder among every
  // section contributing to it here, matching moveSectionProposalOrder's
  // own "moves as one unit" convention for a booth backed by more than
  // one EstimateSection row (estimate-service.ts's own comment).
  const boothSortOrder = new Map<string, number>();
  // Same convention one level down, mirroring groupBoothLineItemsForEditing's
  // own elementSortOrder -- moveElementGroupOrder's up/down otherwise had
  // no effect at all on the client-facing PDF/web proposal (confirmed live:
  // a moved group kept rendering in its old position there even though the
  // editing view already reflected the move correctly).
  const elementSortOrder = new Map<string, number>();
  // The booth's own approved H1 heading override -- prefers a real,
  // non-null value over whichever section is simply encountered first
  // (mirroring groupBoothLineItemsForEditing's own identical fix): every
  // section sharing a groupLabel is SUPPOSED to carry an identical
  // boothDescription (mergeBoothIntoAnotherBooth/resolveOrCreateTargetSection
  // both keep that invariant on write), but this is the read-side
  // backstop against a section that still slipped through with a stale
  // null -- otherwise an approved heading could silently render as the
  // raw, often cryptic groupLabel instead on THIS specific view, even
  // while the Line Items tab kept showing it correctly.
  const boothDescriptionText = new Map<string, string | null>();
  // Whole-booth "hide detail, keep the price" -- read off the first
  // section encountered for this booth, same convention as
  // boothDescription elsewhere (updateSectionProposalSummary always
  // keeps every section sharing a groupLabel in sync, so any one is
  // correct). Deliberately never affects boothSortOrder/elementSortOrder
  // above or the subtotal math below -- only proposal-pdf.tsx's own
  // rendering decision skips elementGroups for a summarized booth.
  const boothSummarize = new Map<string, boolean>();
  // Same "prefer non-null" convention as boothDescriptionText above -- see
  // EstimateSection.boothSummary's own schema comment.
  const boothSummaryText = new Map<string, string | null>();
  // Same convention, one level down, keyed the same way as
  // elementSortOrder above -- an element group is exactly one
  // EstimateSection (no fan-out to worry about), but the map still uses
  // "first section wins" for consistency with every other per-key map
  // here. See EstimateSection.elementSummary's own schema comment.
  const elementSummaryText = new Map<string, string | null>();

  for (const section of sections) {
    if (!section.groupLabel || section.includeInProposal === false) continue;
    const boothLabel = section.groupLabel;
    const elementType = elementTypeForSection(section.name);
    boothSortOrder.set(
      boothLabel,
      Math.min(boothSortOrder.get(boothLabel) ?? Infinity, section.proposalSortOrder ?? 0),
    );
    const elementKey = `${boothLabel}::${elementType}`;
    elementSortOrder.set(elementKey, Math.min(elementSortOrder.get(elementKey) ?? Infinity, section.sortOrder ?? 0));
    if (!elementSummaryText.has(elementKey)) {
      elementSummaryText.set(elementKey, section.elementSummary ?? null);
    }
    if (!boothSummarize.has(boothLabel)) {
      boothSummarize.set(boothLabel, section.summarizeOnProposal ?? false);
    }
    const currentBoothDescription = boothDescriptionText.get(boothLabel);
    if (currentBoothDescription === undefined || (currentBoothDescription === null && section.boothDescription != null)) {
      boothDescriptionText.set(boothLabel, section.boothDescription ?? null);
    }
    const currentBoothSummary = boothSummaryText.get(boothLabel);
    if (currentBoothSummary === undefined || (currentBoothSummary === null && section.boothSummary != null)) {
      boothSummaryText.set(boothLabel, section.boothSummary ?? null);
    }

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
      if (li.includeInProposal === false) continue;
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
    // proposalSortOrder first (an explicit, user-set position), falling
    // back to alphabetical only when two booths are still tied -- every
    // section starts at the same default 0, so this is what keeps a
    // never-yet-reordered category's booths in the same stable order
    // they always rendered in, rather than shuffling once this field
    // existed.
    .sort(([a], [b]) => (boothSortOrder.get(a) ?? 0) - (boothSortOrder.get(b) ?? 0) || a.localeCompare(b))
    .map(([boothLabel, byElementType]) => {
      const elementGroups = [...byElementType.entries()]
        // sortOrder first -- an explicit, user-set position (moveElementGroupOrder
        // now reorders every group in a booth, fixed labels included) --
        // falling back to the fixed build-sequence rank only while every
        // group here still ties at the shared 0 default, i.e. a booth
        // nobody has manually reordered yet. See moveElementGroupOrder's
        // own comment for why a fixed label no longer has to win here.
        .sort(
          ([a], [b]) =>
            (elementSortOrder.get(`${boothLabel}::${a}`) ?? 0) - (elementSortOrder.get(`${boothLabel}::${b}`) ?? 0) ||
            elementTypeRank(a) - elementTypeRank(b),
        )
        .map(([elementType, bucket]) => {
          const items = [...bucket.values()].sort((a, b) => a.sortOrder - b.sortOrder);
          return {
            elementType,
            items,
            subtotal: bucketSubtotal(items),
            elementSummary: elementSummaryText.get(`${boothLabel}::${elementType}`) ?? null,
          };
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
      return {
        boothLabel,
        boothDescription: boothDescriptionText.get(boothLabel) ?? null,
        elementGroups,
        subtotal,
        summarizeOnProposal: boothSummarize.get(boothLabel) ?? false,
        boothSummary: boothSummaryText.get(boothLabel) ?? null,
      };
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

// Companion to boothGroupsByCategory, for the OTHER kind of section whose
// own summarizeOnProposal has to reach this document: a genuinely
// booth-INDEPENDENT (groupLabel: null) section that's been explicitly
// switched to "hide the detail, keep the price" (see
// EstimateSection.summarizeOnProposal's own schema comment) is otherwise
// invisible to boothGroupsByCategory (it requires a real groupLabel) and
// falls through to the flat, cross-section-merged rendering the rest of
// aggregateByCategory uses -- which has no concept of a section boundary
// at all, so the toggle was silently ignored. Confirmed live: a
// standalone section's "Summarized on proposal" badge showed correctly
// in the Line Items tab while the real Proposal PDF itemized every one
// of its rows anyway.
//
// Reuses groupBoothLineItems itself (via a synthetic, per-section
// groupLabel so a summarized section's own items never merge with any
// OTHER section's, unlike the real cross-show merge every other
// booth-independent item still gets -- see aggregateByCategory's own
// comment on why that merge is correct there) rather than a second,
// independent implementation of the same booth-shaped rendering. Only
// the heading is swapped afterward, from the synthetic key to the
// section's own approved description/name. A non-summarized standalone
// section is deliberately NOT included here -- its items keep exactly
// the existing cross-section-merged flat rendering, unaffected.
export function standaloneSummaryGroupsByCategory(
  sections: ProposalViewSection[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): Map<string, BoothGroup[]> {
  const sectionsByCategoryName = new Map<string, ProposalViewSection[]>();
  const sectionByScopeKey = new Map<string, ProposalViewSection>();
  for (const section of sections) {
    if (section.groupLabel || !section.summarizeOnProposal) continue;
    const scopeKey = `__standalone_summary_${section.id ?? section.name}`;
    sectionByScopeKey.set(scopeKey, section);
    const itemsByCategoryName = new Map<string, ProposalViewLineItem[]>();
    for (const li of section.lineItems) {
      const categoryName = resolveEffectiveCategory(li, section, categories);
      const bucket = itemsByCategoryName.get(categoryName);
      if (bucket) bucket.push(li);
      else itemsByCategoryName.set(categoryName, [li]);
    }
    for (const [categoryName, items] of itemsByCategoryName) {
      const clone: ProposalViewSection = { ...section, groupLabel: scopeKey, lineItems: items };
      const arr = sectionsByCategoryName.get(categoryName);
      if (arr) arr.push(clone);
      else sectionsByCategoryName.set(categoryName, [clone]);
    }
  }
  const result = new Map<string, BoothGroup[]>();
  for (const [categoryName, sectionsForCategory] of sectionsByCategoryName) {
    const groups = groupBoothLineItems(sectionsForCategory).map((group) => {
      const section = sectionByScopeKey.get(group.boothLabel);
      return { ...group, boothDescription: section?.description ?? section?.name ?? group.boothLabel };
    });
    result.set(categoryName, groups);
  }
  return result;
}

export interface RawElementTypeGroup<T> {
  elementType: string;
  items: T[];
  subtotal: number;
  // The section(s) this bucket's items came from -- almost always exactly
  // one (a bucket is keyed by (boothLabel, elementType), and normally only
  // one section per booth resolves to a given elementType), but a second
  // section sharing the same name can start contributing here the moment
  // one of its own items gets recategorized into whatever category tab
  // this bucket belongs to (confirmed live: recategorizing a "Shipping"-
  // tab item into a booth's existing "Custom Build" component merges it
  // into that component's own bucket the instant both share a category).
  // description/pendingDescription/editability below still apply in that
  // case -- see isMapped's own comment -- scoped to the FIRST contributing
  // section (the one bucket.description was set from); a second section's
  // own separate description is simply not surfaced through this bucket,
  // same simplification as the single-section case picking one value.
  sectionIds: string[];
  description: string | null;
  pendingDescription: string | null;
  // True only when elementType came from a real ELEMENT_TYPE_MAP entry --
  // deliberately NOT also true just because sectionIds.length > 1.
  // Merging used to force this true (no edit UI, no move-group-order
  // eligibility, same treatment as a real mapped section) -- confirmed
  // live as a real regression once moveElementGroupOrder shipped: an
  // estimator recategorizing one item into an existing custom-named
  // component silently stripped that component's own AI-suggest icon
  // AND its up/down reorder buttons, with no indication why. A merge is
  // just two sections sharing a name, not a special fixed category, so it
  // no longer changes this at all.
  isMapped: boolean;
}

export interface RawBoothGroup<T> {
  boothLabel: string;
  elementGroups: RawElementTypeGroup<T>[];
  subtotal: number;
  // The booth's own H1-level description/pendingDescription -- see
  // EstimateSection.boothDescription's own schema comment. Read off the
  // first section encountered for this booth; kept in sync across every
  // section sharing the booth's groupLabel by updateBoothDescription/
  // clearBoothPendingDescription, so any one section's value is correct.
  boothDescription: string | null;
  boothPendingDescription: string | null;
}

// Same booth -> element-type structure as groupBoothLineItems above, but
// for an editing surface (the Line Items tab's own "Components" view):
// every raw line item stays its own row -- own id, own move/edit/delete
// actions via LineItemRow -- instead of being merged by description+unit
// like the client-facing PDF's read-only version. Generic over T so a
// caller's own, richer LineItem shape (unitCost, isDraft, category, ...)
// passes straight through unchanged; this only ever needs `totalCost` (a
// Decimal, for subtotal math) and `sortOrder` (for display order) off it.
interface EditableSectionBucket<T> {
  items: T[];
  sectionIds: string[];
  // description/pendingDescription of the bucket's first (and, in the
  // overwhelmingly common case, only) contributing section -- see
  // RawElementTypeGroup's own comment on the >1-section merge case.
  description: string | null;
  pendingDescription: string | null;
}

export function groupBoothLineItemsForEditing<T extends { totalCost: Prisma.Decimal; sortOrder: number }>(
  sections: {
    id: string;
    name: string;
    groupLabel: string | null;
    description: string | null;
    pendingDescription: string | null;
    boothDescription: string | null;
    boothPendingDescription: string | null;
    proposalSortOrder?: number;
    sortOrder?: number;
    lineItems: T[];
  }[],
): RawBoothGroup<T>[] {
  const byBooth = new Map<string, Map<string, EditableSectionBucket<T>>>();
  const boothDescriptions = new Map<string, { description: string | null; pendingDescription: string | null }>();
  // Same "min across every section contributing to this booth" convention
  // as groupBoothLineItems' own boothSortOrder -- so the editor renders
  // booths in the exact order moveSectionProposalOrder's up/down actually
  // move them in, not a separate alphabetical order that would make
  // reordering invisible where a user actually clicks it.
  const boothSortOrder = new Map<string, number>();
  // Same convention one level down: a group's (boothLabel, elementType)
  // key maps to the min sortOrder across every section contributing to
  // it, so moveElementGroupOrder's up/down swaps land exactly where this
  // sort puts them. Unlike proposalSortOrder (deliberately per-category,
  // see EstimateSection.proposalSortOrder's own schema comment), a
  // group's relative order is the same everywhere it appears -- it's the
  // same physical section row surfacing in every category tab that
  // section happens to have items in, not a different row per category --
  // so one plain, category-agnostic sortOrder is the correct model here.
  const elementSortOrder = new Map<string, number>();

  for (const section of sections) {
    if (!section.groupLabel) continue;
    const boothLabel = section.groupLabel;
    const elementType = elementTypeForSection(section.name);
    boothSortOrder.set(
      boothLabel,
      Math.min(boothSortOrder.get(boothLabel) ?? Infinity, section.proposalSortOrder ?? 0),
    );
    const elementKey = `${boothLabel}::${elementType}`;
    elementSortOrder.set(elementKey, Math.min(elementSortOrder.get(elementKey) ?? Infinity, section.sortOrder ?? 0));

    // Prefers a non-null value over whichever section is simply encountered
    // first -- every section sharing a groupLabel is SUPPOSED to carry an
    // identical boothDescription (mergeBoothIntoAnotherBooth and
    // resolveOrCreateTargetSection both keep that invariant on write), but
    // this is the read-side backstop for the one moment a new section can
    // still be seen with a stale/null value, so a real approved H1 heading
    // never appears to silently revert just because of array order.
    const currentBoothDescription = boothDescriptions.get(boothLabel);
    if (!currentBoothDescription || (currentBoothDescription.description === null && section.boothDescription !== null)) {
      boothDescriptions.set(boothLabel, {
        description: section.boothDescription,
        pendingDescription: section.boothPendingDescription,
      });
    }

    let byElementType = byBooth.get(boothLabel);
    if (!byElementType) {
      byElementType = new Map();
      byBooth.set(boothLabel, byElementType);
    }
    let bucket = byElementType.get(elementType);
    if (!bucket) {
      bucket = { items: [], sectionIds: [], description: section.description, pendingDescription: section.pendingDescription };
      byElementType.set(elementType, bucket);
    }
    bucket.items.push(...section.lineItems);
    bucket.sectionIds.push(section.id);
  }

  const elementTypeRank = (name: string) => {
    const i = ELEMENT_TYPE_ORDER.indexOf(name);
    return i === -1 ? ELEMENT_TYPE_ORDER.length : i;
  };

  return [...byBooth.entries()]
    .sort(([a], [b]) => (boothSortOrder.get(a) ?? 0) - (boothSortOrder.get(b) ?? 0) || a.localeCompare(b))
    .map(([boothLabel, byElementType]) => {
      const elementGroups = [...byElementType.entries()]
        // sortOrder first -- see groupBoothLineItems' own identical comment
        // (this is the editing-surface counterpart) for why a fixed
        // build-sequence label no longer wins over an explicit move.
        .sort(
          ([a], [b]) =>
            (elementSortOrder.get(`${boothLabel}::${a}`) ?? 0) - (elementSortOrder.get(`${boothLabel}::${b}`) ?? 0) ||
            elementTypeRank(a) - elementTypeRank(b),
        )
        .map(([elementType, bucket]) => {
          const sorted = [...bucket.items].sort((a, b) => a.sortOrder - b.sortOrder);
          const subtotal = sorted.reduce((sum, li) => sum + li.totalCost.toNumber(), 0);
          return {
            elementType,
            items: sorted,
            subtotal,
            sectionIds: bucket.sectionIds,
            description: bucket.description,
            pendingDescription: bucket.pendingDescription,
            // elementType here is already resolved -- a mapped section's
            // elementType is always one of ELEMENT_TYPE_ORDER's 6 fixed
            // target names (elementTypeForSection's own mapping), so
            // checking membership there is equivalent to (and simpler
            // than) re-deriving it from the raw section name.
            isMapped: ELEMENT_TYPE_ORDER.includes(elementType),
          };
        })
        // Same reasoning as groupBoothLineItems' own filter above -- an
        // all-draft section still creates an (elementType, bucket) entry
        // before any items are known to survive.
        .filter((g) => g.items.length > 0);
      if (elementGroups.length === 0) return null;
      const subtotal = elementGroups.reduce((sum, g) => sum + g.subtotal, 0);
      const boothDesc = boothDescriptions.get(boothLabel) ?? { description: null, pendingDescription: null };
      return {
        boothLabel,
        elementGroups,
        subtotal,
        boothDescription: boothDesc.description,
        boothPendingDescription: boothDesc.pendingDescription,
      };
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
  sections: {
    id: string;
    name: string;
    groupLabel: string | null;
    buildType?: SectionBuildType | null;
    description: string | null;
    pendingDescription: string | null;
    boothDescription: string | null;
    boothPendingDescription: string | null;
    proposalSortOrder?: number;
    sortOrder?: number;
    lineItems: T[];
  }[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): Map<string, RawBoothGroup<T>[]> {
  const sectionsByCategoryName = new Map<
    string,
    {
      id: string;
      name: string;
      groupLabel: string | null;
      description: string | null;
      pendingDescription: string | null;
      boothDescription: string | null;
      boothPendingDescription: string | null;
      proposalSortOrder?: number;
      sortOrder?: number;
      lineItems: T[];
    }[]
  >();
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
      const clone = {
        id: section.id,
        name: section.name,
        groupLabel: section.groupLabel,
        description: section.description,
        pendingDescription: section.pendingDescription,
        boothDescription: section.boothDescription,
        boothPendingDescription: section.boothPendingDescription,
        proposalSortOrder: section.proposalSortOrder,
        sortOrder: section.sortOrder,
        lineItems: items,
      };
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

export interface RawCategorySectionGroup<T> {
  sectionId: string;
  sectionName: string;
  groupLabel: string | null;
  // The resolved category this group was actually bucketed under -- always
  // matches the RawCategoryBucket that contains it in
  // bucketLineItemsByCategory's own output, but carried on the group too so
  // a caller merging several categories' buckets into one combined view
  // (see mergeCategoryBucketsForAllMethods) can still tell each group's
  // real category apart instead of assuming every group in the merged view
  // shares its own top-level name -- e.g. the per-section "Move section"
  // dropdown needs this to default to the section's actual leaf category
  // ("Structure - Rental"), not the merged view's Type name ("Structure").
  categoryName: string;
  lineItems: T[];
  description: string | null;
  pendingDescription: string | null;
  // Same meaning as RawElementTypeGroup's own isMapped -- true when
  // sectionName resolves through ELEMENT_TYPE_MAP, so this group's heading
  // stays fixed with no edit/AI-suggestion UI.
  isMapped: boolean;
}

export interface RawCategoryBucket<T> {
  category: { id: string; name: string; key: string };
  totalItems: number;
  sectionGroups: RawCategorySectionGroup<T>[];
}

// Editing-surface counterpart to aggregateByCategory: every live Category
// always gets a bucket, even an empty one, so it always shows as a tab
// (matches Tabs' own header comment on why: a blank Excel sheet still has a
// tab). Buckets by section too, not just category, since a category's items
// still need their originating booth/component visible for production
// tracking and Add Line Item's own sectionId -- this only changes what's
// grouped together for display, not the underlying per-section data model
// LineItem/EstimateSection already are.
//
// Deliberately does NOT merge/sum identical line items across sections the
// way aggregateByCategory does for the client-facing PDF -- that's a
// read-only summary view; this is for editing, which needs every raw
// LineItem individually addressable (its own id, its own move/update/
// delete actions). Generic over T for the same reason
// groupBoothLineItemsForEditing is: the Line Items tab's own richer
// LineItem shape (unitCost, isDraft, category, ...) passes straight through
// unchanged.
export function bucketLineItemsByCategory<T extends { category: string | null }>(
  sections: {
    id: string;
    name: string;
    groupLabel: string | null;
    buildType?: SectionBuildType | null;
    description: string | null;
    pendingDescription: string | null;
    lineItems: T[];
  }[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): RawCategoryBucket<T>[] {
  const byCategoryThenSection = new Map<string, Map<string, RawCategorySectionGroup<T>>>();

  for (const section of sections) {
    for (const li of section.lineItems) {
      // A tagged booth's items resolve to Rental Structures/Custom
      // Components regardless of their own raw category (see
      // resolveEffectiveCategory's own comment) -- an untagged booth falls
      // through to its raw category unchanged, same as any other item.
      // Either way this function still buckets every item; it's
      // CategoryTabContent that skips a booth-linked section's own flat
      // rendering once that booth is also being shown via its own
      // component-grouped view (LineItemsTab's own boothGroups), so
      // nothing renders twice.
      const categoryName = resolveEffectiveCategory(li, section, categories);
      let sectionMap = byCategoryThenSection.get(categoryName);
      if (!sectionMap) {
        sectionMap = new Map();
        byCategoryThenSection.set(categoryName, sectionMap);
      }
      let group = sectionMap.get(section.id);
      if (!group) {
        group = {
          sectionId: section.id,
          sectionName: section.name,
          groupLabel: section.groupLabel,
          categoryName,
          lineItems: [],
          description: section.description,
          pendingDescription: section.pendingDescription,
          isMapped: isMappedElementType(section.name),
        };
        sectionMap.set(section.id, group);
      }
      group.lineItems.push(li);
    }
  }

  return categories.map((category) => {
    const sectionMap = byCategoryThenSection.get(category.name);
    const sectionGroups = sectionMap ? [...sectionMap.values()] : [];
    return {
      category,
      totalItems: sectionGroups.reduce((sum, g) => sum + g.lineItems.length, 0),
      sectionGroups,
    };
  });
}

export interface CategoryMethodTab<T> {
  key: MethodKey;
  label: string;
  bucket: RawCategoryBucket<T>;
}

export interface PrimaryCategoryTab<T> {
  // The Type category's (or flat category's) own id -- used as the primary
  // tab bar's tab id.
  id: string;
  label: string;
  hasMethodSplit: boolean;
  // The Type's own bucket (items whose Method hasn't resolved yet, or a
  // flat category's only bucket) -- always rendered, even when
  // hasMethodSplit is true (an untagged item under a splittable Type still
  // needs somewhere to show up).
  ownBucket: RawCategoryBucket<T>;
  // [] unless hasMethodSplit; otherwise one entry per live Method leaf
  // under this Type, ordered Rental/Purchase/Custom Fabricated.
  methodBuckets: CategoryMethodTab<T>[];
  totalItems: number;
}

const METHOD_KEY_ORDER: MethodKey[] = ["rental", "purchase", "custom_fabricated"];

// Groups the ~28 flat buckets bucketLineItemsByCategory produces (every
// Type parent, every Method leaf, every flat non-split category) into one
// tab per top-level Category -- cutting the category board's tab bar down
// to ~13 without a schema change, since the Type/Method relationship is
// already fully described by each leaf's own stable `key`
// (`${typeKey}_${method}`, see leafCategoryKey).
//
// Identifies a Method leaf by that key pattern, NOT by Category.parentId --
// confirmed necessary against real data, where a Type's own parentId can
// itself be non-null for a reason unrelated to this taxonomy (e.g. hand-
// edited in /catalog/categories); trusting parentId there would make that
// Type wrongly look like someone else's Method leaf, dropping it out of
// the primary tab bar and silently hiding every item under it. `key` is
// the only signal this file already treats as authoritative for exactly
// that reason (see resolveCategoryNameFromKey's own comment).
export function groupPrimaryCategoryTabs<T>(
  buckets: RawCategoryBucket<T>[],
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[],
): PrimaryCategoryTab<T>[] {
  const bucketsById = new Map(buckets.map((b) => [b.category.id, b] as const));
  const byKey = new Map(categories.map((c) => [c.key, c] as const));
  const leafKeys = new Set(
    categories
      .filter((c) => (TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(c.key))
      .flatMap((type) => METHOD_KEY_ORDER.map((method) => `${type.key}_${method}`)),
  );

  return categories
    .filter((c) => !leafKeys.has(c.key))
    .map((parent) => {
      const ownBucket = bucketsById.get(parent.id)!;
      if (!(TYPE_KEYS_WITH_METHOD_SPLIT as readonly string[]).includes(parent.key)) {
        return { id: parent.id, label: parent.name, hasMethodSplit: false, ownBucket, methodBuckets: [], totalItems: ownBucket.totalItems };
      }
      const methodBuckets: CategoryMethodTab<T>[] = METHOD_KEY_ORDER.flatMap((key) => {
        const child = byKey.get(`${parent.key}_${key}`);
        return child ? [{ key, label: METHOD_KEY_LABELS[key], bucket: bucketsById.get(child.id)! }] : [];
      });
      const hasMethodSplit = methodBuckets.length > 0;
      const totalItems = ownBucket.totalItems + methodBuckets.reduce((sum, m) => sum + m.bucket.totalItems, 0);
      return { id: parent.id, label: parent.name, hasMethodSplit, ownBucket, methodBuckets, totalItems };
    });
}

// Combines a Type tab's own bucket with all of its Method buckets into one
// "All" view for the category board's secondary Method pill filter
// (CategoryMethodFilter) -- switching to "All" shows every item under a
// Type regardless of which Method (or none) it's tagged with. Safe to
// concatenate sectionGroups without dedup: a single EstimateSection has
// exactly one buildType, so its items always resolve to exactly one of the
// 4 buckets (the Type's own + its 3 Method leaves), never split across two
// -- see resolveEffectiveCategory.
export function mergeCategoryBucketsForAllMethods<T>(tab: PrimaryCategoryTab<T>): RawCategoryBucket<T> {
  return {
    category: tab.ownBucket.category,
    totalItems: tab.totalItems,
    sectionGroups: [...tab.ownBucket.sectionGroups, ...tab.methodBuckets.flatMap((m) => m.bucket.sectionGroups)],
  };
}

// Booth-group companion to mergeCategoryBucketsForAllMethods above, for the
// same "All" pill -- unions whichever booth groups (from
// boothGroupsByCategoryForEditing's own per-category map) belong to this
// Type's own bucket or any of its Method leaves.
export function mergeBoothGroupsForAllMethods<T>(
  tab: PrimaryCategoryTab<T>,
  boothGroupsByCategoryName: Map<string, RawBoothGroup<T>[]>,
): RawBoothGroup<T>[] {
  const names = [tab.ownBucket.category.name, ...tab.methodBuckets.map((m) => m.bucket.category.name)];
  return names.flatMap((name) => boothGroupsByCategoryName.get(name) ?? []);
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
