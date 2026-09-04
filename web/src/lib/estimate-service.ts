// Framework-agnostic estimate math + mutations, kept separate from any
// future app/estimates/actions.ts the same way opportunity-service.ts is
// kept separate from app/opportunities/actions.ts (see that file's header
// comment). The pure compute functions below have no db dependency at all
// and are the part docs/migration-plan.md's Phase 3 scope calls out by
// name: "Implement the margin gross-up formula with a regression test
// guarding against a markup-formula substitution."

import { db } from "@/lib/db";
import { Prisma, type Category } from "@/generated/prisma/client";
import type {
  BidPackageStatus,
  LineItemAuditAction,
  LineItemType,
  LineItemUsageTag,
  SectionBuildType,
  SectionType,
} from "@/generated/prisma/enums";
import { inferCategoryFromDescription, mapDesignCostCategoryToCanonical } from "@/lib/line-item-category";
import {
  boothGroupsByCategoryForEditing,
  bucketLineItemsByCategory,
  groupBoothLineItemsForEditing,
  resolveEffectiveCategory,
  resolveTypeKeyForCategoryKey,
} from "@/lib/proposal-view-model";

type Decimal = Prisma.Decimal;
type DecimalInput = Decimal | number | string;

// business-rules.md Rules 1-2: material qty x unit cost and labor hours x
// department rate share the same shape. Decimal (not float) throughout --
// these numbers land on real invoices.
export function computeLineItemTotal(qty: DecimalInput, unitCost: DecimalInput): Decimal {
  return new Prisma.Decimal(qty).times(unitCost);
}

// Draft line items (Phase 4 design-intake prototype) are excluded until
// confirmed -- migration-plan.md's "tagged draft ... human-reviewed and
// priced before counting."
export function computeSectionTotal(lineItems: { totalCost: DecimalInput; isDraft?: boolean }[]): Decimal {
  return lineItems
    .filter((li) => !li.isDraft)
    .reduce((sum, li) => sum.plus(li.totalCost), new Prisma.Decimal(0));
}

// business-rules.md Rule 6: sell = cost / ((100 - margin%) / 100), a
// margin gross-up. This is NOT a markup (cost * (1 + margin%/100)) -- the
// two formulas only agree at margin=0 and diverge from there. Verified
// against Yoku Moku's real, client-sent total in estimate-service.test.ts.
// Deliberately excludes Base!B23's 1.03 multiplier (business-rules.md
// Rule 8): that constant's own label ("4% of Grand Total") disagrees with
// its value (1.03 = 3%), so it is unresolved business logic, not a
// confirmed part of the formula -- see the "PRICE OPTIONS" note in
// schema.prisma.
export function computeMarginGrossUp(cost: DecimalInput, marginTargetPct: DecimalInput): Decimal {
  const costD = new Prisma.Decimal(cost);
  const marginD = new Prisma.Decimal(marginTargetPct);
  return costD.dividedBy(new Prisma.Decimal(100).minus(marginD).dividedBy(100));
}

export interface VersionTotals {
  totalCost: Decimal;
  grandTotal: Decimal;
  grossMarginPct: Decimal;
}

// Three-tier fallback for which margin % actually prices one line item:
// (1) an override on the item's own exact resolved category -- supports a
// future Method-leaf-level override (e.g. "Structure - Rental" priced
// differently from "Structure - Purchase") with no schema change, even
// though only Type-level rows get an editable UI control today; (2) an
// override on that category's Type parent, when the resolved category is
// itself a Method leaf (resolveTypeKeyForCategoryKey -- the same key-based
// lookup proposal-view-model.ts's own Type/Method composition uses, never
// Category.parentId, for the same real-data reason documented there); (3)
// the document's own marginTargetPct, now a fallback/default rather than
// the only margin that exists. A category with no override at any tier
// still prices at the document's target, so this is fully backward
// compatible when `overridesByCategoryId` is empty.
export function resolveLineItemMarginPct(
  effectiveCategoryName: string,
  categories: Pick<Category, "id" | "name" | "key">[],
  overridesByCategoryId: Map<string, Decimal>,
  documentMarginPct: DecimalInput,
): Decimal {
  const category = categories.find((c) => c.name === effectiveCategoryName);
  if (!category) return new Prisma.Decimal(documentMarginPct);

  const own = overridesByCategoryId.get(category.id);
  if (own) return own;

  const typeKey = resolveTypeKeyForCategoryKey(category.key);
  if (typeKey) {
    const typeCategory = categories.find((c) => c.key === typeKey);
    const typeOverride = typeCategory && overridesByCategoryId.get(typeCategory.id);
    if (typeOverride) return typeOverride;
  }

  return new Prisma.Decimal(documentMarginPct);
}

// Mirrors Price Summary!J130/J131 ("GROSS MARGIN" = (sell-cost)/sell)
// rather than just echoing marginTargetPct back -- computing it
// independently is a sanity check that grandTotal was actually derived by
// gross-up, not some other path.
//
// Grosses up PER LINE ITEM (each at its own resolveLineItemMarginPct-
// resolved rate) and sums, rather than summing cost once and grossing up
// the total -- this is what actually lets different categories carry
// different margins. computeMarginGrossUp is a linear scalar
// (cost * 100/(100-pct)), so whenever every item resolves to the same
// margin (no overrides set), summing per-item gross-ups is mathematically
// identical to grossing up the summed total once -- today's behavior is
// preserved exactly, not approximated, when `categories`/
// `overridesByCategoryId` carry no overrides.
export function computeVersionTotals(
  version: {
    marginTargetPct: DecimalInput;
    sections: {
      groupLabel: string | null;
      buildType?: SectionBuildType | null;
      excludedFromTotals?: boolean;
      lineItems: { totalCost: DecimalInput; isDraft?: boolean; category: string | null }[];
    }[];
  },
  categories: Pick<Category, "id" | "name" | "key" | "parentId">[] = [],
  overridesByCategoryId: Map<string, Decimal> = new Map(),
): VersionTotals {
  let totalCost = new Prisma.Decimal(0);
  let grandTotal = new Prisma.Decimal(0);

  for (const section of version.sections) {
    // Real, useful estimating work (a labor/freight rate comparison
    // against another vendor, a competitor-bid snapshot) that happens to
    // live inside this version but isn't real client scope -- see
    // EstimateSection.excludedFromTotals's own schema comment. Skipped
    // entirely here, unlike includeInProposal/summarizeOnProposal which
    // never reach this function at all (PDF-only concerns).
    if (section.excludedFromTotals) continue;
    for (const li of section.lineItems) {
      if (li.isDraft) continue;
      const cost = new Prisma.Decimal(li.totalCost);
      const categoryName = resolveEffectiveCategory(li, section, categories);
      const marginPct = resolveLineItemMarginPct(categoryName, categories, overridesByCategoryId, version.marginTargetPct);
      totalCost = totalCost.plus(cost);
      grandTotal = grandTotal.plus(computeMarginGrossUp(cost, marginPct));
    }
  }

  const grossMarginPct = grandTotal.isZero()
    ? new Prisma.Decimal(0)
    : grandTotal.minus(totalCost).dividedBy(grandTotal).times(100);

  return { totalCost, grandTotal, grossMarginPct };
}

// Only base-estimate sections (optionId: null) count toward version
// totals -- an Option's sections are an alternate/upgrade path, priced
// separately (see computeOptionTotal below), not part of the base cost.
const VERSION_WITH_TOTALS_INCLUDE = {
  sections: { where: { optionId: null }, include: { lineItems: true } },
} satisfies Prisma.EstimateVersionInclude;

export function assertEstimateNotArchived(estimate: { id: string; archivedAt: Date | null }) {
  if (estimate.archivedAt) {
    throw new Error(`Estimate ${estimate.id} is archived and cannot be edited -- unarchive it first.`);
  }
}

export async function assertUnlocked(estimateVersionId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: { estimate: { select: { id: true, archivedAt: true } } },
  });
  if (version.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is locked and cannot be edited.`);
  }
  assertEstimateNotArchived(version.estimate);
  return version;
}

export async function createEstimateVersion(estimateId: string, marginTargetPct: DecimalInput = 0) {
  const estimate = await db.estimate.findUniqueOrThrow({ where: { id: estimateId }, select: { id: true, archivedAt: true } });
  assertEstimateNotArchived(estimate);

  const previousCurrent = await db.estimateVersion.findFirst({
    where: { estimateId, isCurrent: true },
    orderBy: { versionNumber: "desc" },
  });

  const results = await db.$transaction([
    ...(previousCurrent
      ? [db.estimateVersion.update({ where: { id: previousCurrent.id }, data: { isCurrent: false } })]
      : []),
    db.estimateVersion.create({
      data: {
        estimateId,
        versionNumber: (previousCurrent?.versionNumber ?? 0) + 1,
        marginTargetPct: new Prisma.Decimal(marginTargetPct),
        isCurrent: true,
        isLocked: false,
      },
    }),
  ]);

  return results.at(-1)!;
}

export async function addSection(
  estimateVersionId: string,
  data: {
    name: string;
    sectionType: SectionType;
    sortOrder?: number;
    optionId?: string | null;
    groupLabel?: string | null;
    buildType?: SectionBuildType | null;
    // A brand-new section has no category of its own -- EstimateSection
    // carries no category field at all; membership in a category tab is
    // resolved entirely from its line items' own category (see
    // resolveEffectiveCategory). Without at least one item, a new section
    // has nothing to resolve one from and never appears in any category
    // tab's grouped view -- confirmed live as a real "I added a section
    // and now can't find it anywhere" report. Passing this seeds one $0
    // placeholder item tagged to it, so the section is visible, as a real
    // H1/H2, in the exact category tab it was created from, immediately.
    placeholderCategory?: string | null;
  },
  actorId?: string | null,
) {
  await assertUnlocked(estimateVersionId);
  const section = await db.estimateSection.create({
    data: {
      estimateVersionId,
      name: data.name,
      sectionType: data.sectionType,
      sortOrder: data.sortOrder ?? 0,
      optionId: data.optionId,
      groupLabel: data.groupLabel,
      buildType: data.buildType ?? null,
    },
  });
  if (data.placeholderCategory) {
    await addLineItem(
      estimateVersionId,
      section.id,
      {
        lineType: "MATERIAL",
        description: "New item -- edit me",
        category: data.placeholderCategory,
        qty: 1,
        unitCost: 0,
      },
      actorId,
    );
  }
  return section;
}

// A booth's buildType is shared across every section carrying its
// groupLabel (updateSectionBuildType always sets them together) -- this is
// the read-side half of that invariant, used by the actions layer so a new
// section joining an EXISTING booth always inherits its real buildType
// rather than trusting whatever a submitted form field happened to say.
// Returns null for a genuinely new groupLabel (nothing to inherit yet --
// the caller decides what to do with that, e.g. require an explicit
// buildType to create a brand-new booth).
export async function resolveBoothBuildType(
  estimateVersionId: string,
  groupLabel: string,
): Promise<SectionBuildType | null> {
  const existing = await db.estimateSection.findFirst({
    where: { estimateVersionId, groupLabel },
    select: { buildType: true },
  });
  return existing?.buildType ?? null;
}

// Tags every EstimateSection sharing this groupLabel (usually one row per
// booth, but safe if a booth ever spans more than one section) with a
// build type -- see SectionBuildType's own schema comment on why this is
// always an explicit human choice, never inferred from import data.
// Scoped to estimateVersionId so a groupLabel that happens to repeat
// across a different version can never be cross-contaminated.
//
// buildType accepts null (untag) as well as a real value: a component
// whose real content spans genuinely different categories the estimator
// wants to keep distinct (a vendor AV bid comparison mixed into a booth
// build, a hanging-sign component whose graphics shouldn't disappear into
// Custom Build) needs a way back to "resolve by each item's own raw
// category" -- confirmed live need, not hypothetical: tagging a
// Fuse-AV-bid-comparison-style section swallowed ~$50k of real Audio/
// Visual pricing into Custom Build with no way to surface it again.
export async function updateSectionBuildType(
  estimateVersionId: string,
  groupLabel: string,
  buildType: SectionBuildType | null,
) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel },
    data: { buildType },
  });
}

// Shared by the three proposal-facing section toggles below -- a real
// booth is often several EstimateSection rows sharing one groupLabel, so
// toggling "the booth" has to updateMany by that label to keep every one
// of them in sync (same reasoning as updateSectionBuildType above). A
// standalone/flat section (groupLabel: null, e.g. one added via "Add
// section" with Group left blank) has no such shared identity -- and
// { groupLabel: null } would match EVERY other flat section in the
// version too, not just this one -- so it's addressed by its own
// sectionId instead. Same shape as moveLineItemsToCategory's own
// CategoryMoveScope.
export type SectionScope = { sectionId: string } | { groupLabel: string };

function sectionScopeWhere(estimateVersionId: string, scope: SectionScope) {
  return "sectionId" in scope
    ? { id: scope.sectionId, estimateVersionId }
    : { estimateVersionId, groupLabel: scope.groupLabel };
}

// Whole-booth (or single standalone section's) Proposal PDF visibility --
// see sectionScopeWhere above for why this is scoped by groupLabel for a
// real booth but by sectionId for a standalone one. See
// EstimateSection.includeInProposal's own schema comment for why this is
// booth-wide while proposalSortOrder below deliberately isn't.
export async function updateSectionProposalVisibility(
  estimateVersionId: string,
  scope: SectionScope,
  includeInProposal: boolean,
) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: sectionScopeWhere(estimateVersionId, scope),
    data: { includeInProposal },
  });
}

// Same scoping as updateSectionProposalVisibility above -- see
// EstimateSection.summarizeOnProposal's own schema comment for how this
// differs from that one (this never removes the booth's cost from any
// total, only its itemized detail on the client-facing PDF).
export async function updateSectionProposalSummary(
  estimateVersionId: string,
  scope: SectionScope,
  summarizeOnProposal: boolean,
) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: sectionScopeWhere(estimateVersionId, scope),
    data: { summarizeOnProposal },
  });
}

// Same scoping as updateSectionProposalVisibility/
// updateSectionProposalSummary above -- see
// EstimateSection.excludedFromTotals's own schema comment for how this
// differs from those two: this one DOES change the estimate's own
// numbers (computeVersionTotals skips excluded sections entirely), so it
// recomputes and persists totalCost/grandTotal immediately rather than
// waiting for some unrelated line-item edit to trigger it.
export async function updateSectionExcludedFromTotals(
  estimateVersionId: string,
  scope: SectionScope,
  excludedFromTotals: boolean,
) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: sectionScopeWhere(estimateVersionId, scope),
    data: { excludedFromTotals },
  });
  await recomputeVersionTotals(estimateVersionId);
}

// Reorders one booth (identified by groupLabel) among only the OTHER
// booths actually visible within one specific category -- deliberately
// scoped per-category, not a global reorder, to avoid the exact ambiguity
// that got the Line Items tab's own old per-section up/down arrows
// removed (see EstimateSection.proposalSortOrder's own schema comment).
// Reuses boothGroupsByCategoryForEditing -- the same grouping the editor
// itself already renders -- so "the next booth up" here is always the
// same booth a user would see immediately above this one in that
// category's tab, never one that happens to share a sortOrder value in
// some other, unrelated category. A booth backed by more than one
// EstimateSection row within this one category (the documented
// sectionIds.length > 1 edge case, RawElementTypeGroup's own comment)
// moves as a single unit -- its header renders once, not once per
// underlying row, so its position has to be one real number, not several
// independently-movable ones.
export async function moveSectionProposalOrder(
  estimateVersionId: string,
  groupLabel: string,
  categoryName: string,
  direction: "up" | "down",
) {
  await assertUnlocked(estimateVersionId);

  const [sections, categories] = await Promise.all([
    db.estimateSection.findMany({
      where: { estimateVersionId },
      select: {
        id: true,
        name: true,
        groupLabel: true,
        buildType: true,
        proposalSortOrder: true,
        description: true,
        pendingDescription: true,
        boothDescription: true,
        boothPendingDescription: true,
        lineItems: { select: { id: true, totalCost: true, sortOrder: true, category: true } },
      },
    }),
    db.category.findMany({ where: { deletedAt: null }, select: { id: true, name: true, key: true, parentId: true } }),
  ]);

  const boothGroups = boothGroupsByCategoryForEditing(sections, categories).get(categoryName) ?? [];
  const sectionsById = new Map(sections.map((s) => [s.id, s]));

  const siblings = boothGroups.map((group) => {
    const sectionIds = [...new Set(group.elementGroups.flatMap((eg) => eg.sectionIds))];
    const sortKey = Math.min(...sectionIds.map((id) => sectionsById.get(id)?.proposalSortOrder ?? 0));
    return { boothLabel: group.boothLabel, sectionIds, sortKey };
  });
  // Stable, deterministic tiebreak (alphabetical) -- every existing row
  // starts at the same default 0, so without this every booth in a
  // never-yet-reordered category would compare equal and sort in
  // whatever arbitrary order the query happened to return them.
  siblings.sort((a, b) => a.sortKey - b.sortKey || a.boothLabel.localeCompare(b.boothLabel));

  const index = siblings.findIndex((s) => s.boothLabel === groupLabel);
  if (index === -1) return;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= siblings.length) return;

  const reordered = [...siblings];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  const updates = reordered.flatMap((sibling, i) => sibling.sectionIds.map((id) => ({ id, sortOrder: i })));
  if (updates.length === 0) return;

  // A single batched UPDATE, not one db.estimateSection.update() per
  // sectionId -- a category with many booths (each often spanning
  // several sections) meant every up/down click was previously paying
  // one full network round-trip to Postgres PER section being
  // renumbered, not just the two booths that actually swapped. Confirmed
  // live as the one remaining slow action after the tab/index/query
  // fixes elsewhere in this file: moveLineItemWithinSection's own
  // transaction stays small (bounded to one section's own line items),
  // but this one renumbers every sibling booth in the whole category on
  // every call, so its round-trip count scales with category size
  // instead. Same end state as the row-by-row version -- this is a
  // batching change only, not a semantics change.
  await db.$executeRaw`
    UPDATE "estimate_sections" AS es
    SET "proposalSortOrder" = v.sort_order
    FROM (VALUES ${Prisma.join(updates.map((u) => Prisma.sql`(${u.id}::text, ${u.sortOrder}::int)`))}) AS v(id, sort_order)
    WHERE es.id = v.id
  `;
}

// Standalone-section counterpart to moveSectionProposalOrder above -- a
// section with no groupLabel (e.g. one added via "Add section" with
// Group left blank) is never part of a multi-section booth, so its
// siblings here are the OTHER standalone sections showing in this same
// category tab (bucketLineItemsByCategory's own sectionGroups, filtered
// to groupLabel: null -- the exact set the Line Items tab renders as
// flatSectionGroups), not boothGroupsByCategoryForEditing's booths.
// Reuses the same proposalSortOrder field a booth's reorder writes to --
// the two lists render as separate blocks (booths, then standalone
// sections) so they never need to interleave against each other.
export async function moveFlatSectionProposalOrder(
  estimateVersionId: string,
  sectionId: string,
  categoryName: string,
  direction: "up" | "down",
) {
  await assertUnlocked(estimateVersionId);

  const [sections, categories] = await Promise.all([
    db.estimateSection.findMany({
      where: { estimateVersionId },
      select: {
        id: true,
        name: true,
        groupLabel: true,
        buildType: true,
        description: true,
        pendingDescription: true,
        proposalSortOrder: true,
        lineItems: { select: { id: true, category: true } },
      },
    }),
    db.category.findMany({ where: { deletedAt: null }, select: { id: true, name: true, key: true, parentId: true } }),
  ]);

  const sectionsById = new Map(sections.map((s) => [s.id, s]));
  const bucket = bucketLineItemsByCategory(sections, categories).find((b) => b.category.name === categoryName);
  const siblings = (bucket?.sectionGroups ?? [])
    .filter((g) => !g.groupLabel)
    .map((g) => ({
      sectionId: g.sectionId,
      sortKey: sectionsById.get(g.sectionId)?.proposalSortOrder ?? 0,
      name: g.sectionName,
    }));
  // Same stable alphabetical tiebreak as moveSectionProposalOrder above.
  siblings.sort((a, b) => a.sortKey - b.sortKey || a.name.localeCompare(b.name));

  const index = siblings.findIndex((s) => s.sectionId === sectionId);
  if (index === -1) return;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= siblings.length) return;

  const reordered = [...siblings];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  await db.$executeRaw`
    UPDATE "estimate_sections" AS es
    SET "proposalSortOrder" = v.sort_order
    FROM (VALUES ${Prisma.join(reordered.map((s, i) => Prisma.sql`(${s.sectionId}::text, ${i}::int)`))}) AS v(id, sort_order)
    WHERE es.id = v.id
  `;
}

// Moves an H2 group (an elementType within one booth, groupBoothLineItems
// ForEditing's own unit) up/down relative to its sibling groups in the
// SAME booth -- unlike moveSectionProposalOrder above, this is
// deliberately category-agnostic: an H2 group is one real physical
// section (or, rarely, a merged handful) that surfaces identically in
// every category tab its own items happen to touch, not a different row
// per category the way a booth's presence in several tabs can be -- see
// EstimateSection.sortOrder vs proposalSortOrder's own schema comments.
//
// Reorders EVERY group in the booth, including the 6 fixed ELEMENT_TYPE_
// MAP labels (Wall Structure/Hardware/Wall Covering/Graphics/Labor/
// Shipping) -- their "natural build sequence" position
// (elementTypeRank in proposal-view-model.ts) is only ever a DEFAULT for
// a booth nobody has touched yet, not a hard rule. Confirmed live as a
// real, wanted case: a manually-built component (e.g. "FS - Hitting Bay
// Wall") wants its own custom groups ("Custom Hitting Bay Wall With
// Monitors", "Structure") ordered above "Shipping," not the generic
// frame-then-covering-then-shipping sequence that fixed rank was
// designed around for a different (BeMatrix/Wall Panels style) import
// shape. isMapped keeps its own, unrelated meaning here (whether this
// group's heading gets AI-suggest/manual-edit UI) -- unaffected by this.
export async function moveElementGroupOrder(
  estimateVersionId: string,
  groupLabel: string,
  elementType: string,
  direction: "up" | "down",
) {
  await assertUnlocked(estimateVersionId);

  const sections = await db.estimateSection.findMany({
    where: { estimateVersionId, groupLabel },
    select: {
      id: true,
      name: true,
      groupLabel: true,
      description: true,
      pendingDescription: true,
      boothDescription: true,
      boothPendingDescription: true,
      sortOrder: true,
      lineItems: { select: { id: true, totalCost: true, sortOrder: true } },
    },
  });

  const [boothGroup] = groupBoothLineItemsForEditing(sections);
  if (!boothGroup) return;

  const movable = boothGroup.elementGroups;
  const index = movable.findIndex((g) => g.elementType === elementType);
  if (index === -1) return;
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= movable.length) return;

  const reordered = [...movable];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  const updates = reordered.flatMap((group, i) => group.sectionIds.map((id) => ({ id, sortOrder: i })));
  if (updates.length === 0) return;

  await db.$executeRaw`
    UPDATE "estimate_sections" AS es
    SET "sortOrder" = v.sort_order
    FROM (VALUES ${Prisma.join(updates.map((u) => Prisma.sql`(${u.id}::text, ${u.sortOrder}::int)`))}) AS v(id, sort_order)
    WHERE es.id = v.id
  `;
}

// Deletes an entire H2 group -- every line item across every raw
// EstimateSection backing this one rendered elementType block under this
// booth (a booth's H2 group can span more than one section row, same
// "merged for display" case moveElementGroupOrder above already has to
// account for), plus those now-empty section rows themselves. Re-derives
// exactly which sections/items belong to this group server-side the same
// way moveElementGroupOrder does, rather than trusting a client-supplied
// sectionId list.
//
// Reuses deleteLineItem item-by-item rather than a raw deleteMany, so
// every item still gets its own DELETE audit-log row and stays
// individually restorable from the History tab -- deleting a whole group
// in one click is a convenience, not a different, less-recoverable kind
// of delete than removing its items one at a time.
export async function deleteElementGroup(
  opportunityId: string,
  estimateVersionId: string,
  groupLabel: string,
  elementType: string,
  actorId?: string | null,
) {
  await assertUnlocked(estimateVersionId);

  const sections = await db.estimateSection.findMany({
    where: { estimateVersionId, groupLabel },
    select: {
      id: true,
      name: true,
      groupLabel: true,
      description: true,
      pendingDescription: true,
      boothDescription: true,
      boothPendingDescription: true,
      sortOrder: true,
      lineItems: { select: { id: true, totalCost: true, sortOrder: true } },
    },
  });
  const [boothGroup] = groupBoothLineItemsForEditing(sections);
  const target = boothGroup?.elementGroups.find((g) => g.elementType === elementType);
  if (!target) return;

  for (const item of target.items) {
    await deleteLineItem(opportunityId, item.id, actorId);
  }
  await db.estimateSection.deleteMany({ where: { id: { in: target.sectionIds } } });
}

// Deletes a genuinely empty H2 group -- one just added via "+ Group" (or
// imported with no items yet) that never got its first line item. See
// emptyChildSections' own comment in the page component for why this is a
// real, separate render path from deleteElementGroup above: a section
// with zero items never appears in groupBoothLineItemsForEditing's own
// elementGroups (that's built entirely from existing line items), so it
// was previously invisible to that delete tool too -- confirmed live as
// a real "three empty groups with no way to delete them" report. No line
// items to snapshot/audit-log here, unlike deleteElementGroup -- there's
// nothing to lose, just the empty container itself.
export async function deleteEmptySection(estimateVersionId: string, sectionId: string) {
  await assertUnlocked(estimateVersionId);
  const section = await db.estimateSection.findFirstOrThrow({
    where: { id: sectionId, estimateVersionId },
    select: { id: true, lineItems: { select: { id: true } } },
  });
  if (section.lineItems.length > 0) {
    throw new Error("This group still has line items -- move or delete them first.");
  }
  await db.estimateSection.delete({ where: { id: sectionId } });
}

// Approve-with-text (green check on an AI suggestion) or a manual save --
// either way the result lands in this (section, category) pair's own
// EstimateSectionCategoryDescription row (creating it on first edit) and
// any pending suggestion for that same pair is cleared, since it's now
// superseded either by the user's own approval or by their own hand-typed
// text. Scoped by categoryId -- see that model's own schema comment for
// why a section's heading can't just live on EstimateSection.description
// directly: the same section can surface its own H1 card under several
// different category tabs at once, and an edit made from one of those
// tabs must never rewrite what a different tab shows.
export async function updateSectionDescription(sectionId: string, categoryId: string, description: string) {
  const section = await db.estimateSection.findUniqueOrThrow({
    where: { id: sectionId },
    select: { estimateVersionId: true },
  });
  await assertUnlocked(section.estimateVersionId);
  await db.estimateSectionCategoryDescription.upsert({
    where: { sectionId_categoryId: { sectionId, categoryId } },
    create: { sectionId, categoryId, description, pendingDescription: null },
    update: { description, pendingDescription: null },
  });
}

// Reject (red X) -- clears only this (section, category) pair's pending
// suggestion, leaving its `description` untouched (null in the common
// case, reverting that category's heading back to its empty/"Suggest with
// AI" prompt state). Every other category showing this same section keeps
// its own independent state either way.
export async function clearSectionPendingDescription(sectionId: string, categoryId: string) {
  const section = await db.estimateSection.findUniqueOrThrow({
    where: { id: sectionId },
    select: { estimateVersionId: true },
  });
  await assertUnlocked(section.estimateVersionId);
  await db.estimateSectionCategoryDescription.upsert({
    where: { sectionId_categoryId: { sectionId, categoryId } },
    create: { sectionId, categoryId, pendingDescription: null },
    update: { pendingDescription: null },
  });
}

// Same propose/approve/reject shape as updateSectionDescription/
// clearSectionPendingDescription above, for the H2/element tier of the
// Proposal PDF copy system -- see EstimateSection.elementSummary's own
// schema comment. Single-section scope, same as description above (an
// element group IS one EstimateSection row, no groupLabel sync needed).
export async function updateElementSummary(sectionId: string, summary: string) {
  const section = await db.estimateSection.findUniqueOrThrow({
    where: { id: sectionId },
    select: { estimateVersionId: true },
  });
  await assertUnlocked(section.estimateVersionId);
  await db.estimateSection.update({
    where: { id: sectionId },
    data: { elementSummary: summary, elementPendingSummary: null },
  });
}

export async function clearElementPendingSummary(sectionId: string) {
  const section = await db.estimateSection.findUniqueOrThrow({
    where: { id: sectionId },
    select: { estimateVersionId: true },
  });
  await assertUnlocked(section.estimateVersionId);
  await db.estimateSection.update({
    where: { id: sectionId },
    data: { elementPendingSummary: null },
  });
}

// Booth-level counterparts to the two mutations above, for the H1
// heading -- same updateMany-by-groupLabel pattern as
// updateSectionBuildType, since a booth is every section sharing one
// groupLabel rather than a model of its own.
export async function updateBoothDescription(estimateVersionId: string, groupLabel: string, description: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel },
    data: { boothDescription: description, boothPendingDescription: null },
  });
}

export async function clearBoothPendingDescription(estimateVersionId: string, groupLabel: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel },
    data: { boothPendingDescription: null },
  });
}

// Same propose/approve/reject shape as updateBoothDescription/
// clearBoothPendingDescription above, for the few-sentence body text a
// summarized booth shows on the Proposal PDF instead of its itemized
// detail -- see EstimateSection.boothSummary's own schema comment.
export async function updateBoothSummary(estimateVersionId: string, groupLabel: string, summary: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel },
    data: { boothSummary: summary, boothPendingSummary: null },
  });
}

export async function clearBoothPendingSummary(estimateVersionId: string, groupLabel: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel },
    data: { boothPendingSummary: null },
  });
}

// A category move's scope -- a whole section (the per-section "Move
// section" dropdown, for a section with no groupLabel so ineligible for the
// Rental/Custom Build tagging above, e.g. a generic "Platform" section whose
// items all matched the "platform"/"sleeper floor" description heuristic
// into Flooring when they're really rental structure), a whole booth (the
// booth-header "Move booth" dropdown -- every section sharing one
// groupLabel at once, so a multi-section booth doesn't need "Move section"
// clicked once per contributing section), or an arbitrary, hand-picked
// cross-section set of line items (the sticky bulk-move bar, via the Line
// Items tab's own selection checkbox, bid-package-selection.tsx -- covers a
// handful of items on a booth-tagged section that were mis-typed at import
// and need moving individually, not the section's other items alongside
// them).
export type CategoryMoveScope = { sectionId: string } | { groupLabel: string } | { lineItemIds: string[] };

// Moves every LineItem in scope to a different category in one step --
// merges what were previously two near-identical functions
// (updateSectionItemsCategory, bulkMoveLineItemsCategory), which only ever
// differed in this where clause, never the write itself. Scoped to
// estimateVersionId the same defensive way as every other bulk write here:
// a sectionId/groupLabel is already version-scoped by the caller's own
// access check, and lineItemIds is caller-suppliable (a client selection
// Set serialized into a direct server-action call, not a real form field),
// so a fictitious/foreign id in the list is simply excluded by the where
// clause rather than trusted.
export async function moveLineItemsToCategory(estimateVersionId: string, scope: CategoryMoveScope, category: string) {
  await assertUnlocked(estimateVersionId);
  const where =
    "sectionId" in scope
      ? { sectionId: scope.sectionId, section: { estimateVersionId } }
      : "groupLabel" in scope
        ? { section: { groupLabel: scope.groupLabel, estimateVersionId } }
        : { id: { in: scope.lineItemIds }, section: { estimateVersionId } };
  await db.lineItem.updateMany({ where, data: { category } });
}

// The missing primitive for moving a line item to a different H2 group
// (EstimateSection) within the SAME estimate -- moveLineItemToEstimate
// above moves one to a different estimate entirely, and nothing else in
// this file ever changes a LineItem's sectionId. Confirmed live as a real
// gap: an item filed under the wrong H2 (e.g. "Custom Display Wall with
// Oak Slatpanel" when it's really "BeMatrix Rental") had no way to move
// without deleting and re-adding it. Re-verifies both the items AND the
// target section belong to this exact version -- same ownership
// discipline as moveLineItemsToCategory above -- and appends the moved
// items after whatever's already in the target section (never
// interleaved into the middle of its existing order) rather than
// resetting every item's sortOrder there.
export async function moveLineItemsToSection(estimateVersionId: string, lineItemIds: string[], targetSectionId: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateSection.findFirstOrThrow({ where: { id: targetSectionId, estimateVersionId } });

  const [items, maxSortOrder] = await Promise.all([
    db.lineItem.findMany({
      where: { id: { in: lineItemIds }, section: { estimateVersionId } },
      select: { id: true },
    }),
    db.lineItem.aggregate({ where: { sectionId: targetSectionId }, _max: { sortOrder: true } }),
  ]);
  if (items.length === 0) return;

  const startingSortOrder = (maxSortOrder._max.sortOrder ?? -1) + 1;
  await db.$transaction(
    items.map((item, i) =>
      db.lineItem.update({ where: { id: item.id }, data: { sectionId: targetSectionId, sortOrder: startingSortOrder + i } }),
    ),
  );
}

// Resolves the (booth, group name) an estimator typed in the "Move to
// group" bar into a real target sectionId -- reuses an existing H2 under
// that booth (or project-wide, when groupLabel is null) if the name
// already matches one, case-insensitively, same loose-matching leniency
// "Add section"'s own Group field already relies on; otherwise creates a
// brand-new one via addSection. Deliberately does NOT throw when the
// target booth has no buildType yet (unlike addSectionToBoothAction's own
// stricter "+Group" tool) -- this is a general relocate-my-items tool,
// not the Method-tagging flow that check exists for, so it just carries
// through whatever buildType (including none) the booth's other sections
// already have via resolveBoothBuildType.
export async function resolveOrCreateTargetSection(
  estimateVersionId: string,
  groupLabel: string | null,
  sectionName: string,
  actorId?: string | null,
) {
  const existing = await db.estimateSection.findFirst({
    where: { estimateVersionId, groupLabel, name: { equals: sectionName, mode: "insensitive" } },
  });
  if (existing) return existing;

  const buildType = groupLabel ? await resolveBoothBuildType(estimateVersionId, groupLabel) : null;
  return addSection(estimateVersionId, { name: sectionName, sectionType: "COMPONENT", groupLabel, buildType }, actorId);
}

// Merges an entire booth into a different existing one -- every
// EstimateSection sharing sourceGroupLabel takes on targetGroupLabel
// instead. For the case surfaced live: an import (or a manually
// "Add section"-ed group label with a typo) ends up with two separate H1
// groups for what's really one booth -- e.g. "Section 203 - Camera Booth"
// and "Section 203 - Booth" -- and everything under the first needs to
// become part of the second. A booth has no model of its own (see
// EstimateSection.groupLabel's own comment); merging is just changing
// which shared string every one of the source sections carries.
//
// Clears the incoming sections' own boothDescription/boothPendingDescription
// rather than trying to reconcile them with the target's -- the view layer
// reads whichever section it finds first for a groupLabel
// (groupBoothLineItemsForEditing), so the source booth's own description
// text would otherwise sit orphaned in the DB, winning that pick or not
// depending on section ordering. Clearing it makes the target booth's own
// description unambiguously the one that applies after a merge; buildType
// and proposalSortOrder are left as-is on the incoming sections (a booth
// already tolerates its own sections carrying different buildTypes when
// tagged separately, and proposalSortOrder settles the next time someone
// actually reorders the merged booth).
export async function mergeBoothIntoAnotherBooth(
  estimateVersionId: string,
  sourceGroupLabel: string,
  targetGroupLabel: string,
) {
  await assertUnlocked(estimateVersionId);
  if (sourceGroupLabel === targetGroupLabel) {
    throw new Error("Choose a different booth to merge into.");
  }
  // Re-verified against the DB rather than trusted from the caller-supplied
  // string alone -- same ownership discipline as every other
  // caller-supplied-identifier check in this file (see
  // opportunity-access.ts's own header comment on the general pattern).
  // Without this, a typo'd or stale target groupLabel would silently
  // create a brand-new, phantom booth instead of merging into a real one.
  const targetExists = await db.estimateSection.findFirst({
    where: { estimateVersionId, groupLabel: targetGroupLabel },
    select: { id: true },
  });
  if (!targetExists) throw new Error("Target booth not found on this estimate version.");

  await db.estimateSection.updateMany({
    where: { estimateVersionId, groupLabel: sourceGroupLabel },
    data: { groupLabel: targetGroupLabel, boothDescription: null, boothPendingDescription: null },
  });
}

// Swaps a section with its immediate neighbor (by current display order)
// in the given direction -- siblings are every other section sharing the
// same estimateVersionId AND optionId (an Option's own sections reorder
// independently from the base estimate's). Renumbers ALL siblings to a
// dense 0..n-1 sequence rather than swapping two raw sortOrder values,
// since freshly-created sections all default to sortOrder 0 -- a plain
// swap between two zeroes would be a no-op. A no-op (already at the top/
// bottom) is silently ignored rather than an error, since a UI button
// simply won't be at an edge case the caller needs to specially handle.
// opportunityId is the caller's already-access-checked opportunity (via
// opportunity-access.ts's estimateOpportunityId), NOT trusted from
// sectionId alone -- see deleteLineItem's header comment for the full
// rationale.
export async function moveSectionOrder(opportunityId: string, sectionId: string, direction: "up" | "down") {
  const section = await db.estimateSection.findFirstOrThrow({
    where: { id: sectionId, estimateVersion: { estimate: { opportunityId } } },
  });
  await assertUnlocked(section.estimateVersionId);

  const siblings = await db.estimateSection.findMany({
    where: { estimateVersionId: section.estimateVersionId, optionId: section.optionId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const index = siblings.findIndex((s) => s.id === sectionId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= siblings.length) return;

  const reordered = [...siblings];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  await db.$transaction(
    reordered.map((s, i) => db.estimateSection.update({ where: { id: s.id }, data: { sortOrder: i } })),
  );
}

// Same as addSection, but reuses an existing section with the same
// (name, groupLabel) pair in this version (base estimate only, not an
// Option) instead of always creating a new one. Needed once a version can
// receive commits from more than one document (see
// estimate-synthesis-service.ts's buildEstimateFromAllDocuments) --
// without this, two documents that both produce an "Other" category (or
// two Pricing Schedule sheets that both have a "TemporaryBooth_BUILD"
// category) each got their own duplicate section instead of one merged
// one, on a real test job. groupLabel is part of the match key too --
// otherwise every booth's identically-named "Platform" sub-section would
// collapse into a single shared one across all booths.
export async function findOrCreateSection(
  estimateVersionId: string,
  data: {
    name: string;
    sectionType: SectionType;
    sortOrder?: number;
    groupLabel?: string | null;
    // Defaults to base-version (null), exactly this function's prior
    // hardcoded behavior -- every existing caller is unaffected. Set by
    // an importer that lets a reviewer route specific rows into a real
    // Option instead (see spreadsheet-line-item-service.ts's
    // sheetDestinations) rather than the base version.
    optionId?: string | null;
  },
) {
  const optionId = data.optionId ?? null;
  const existing = await db.estimateSection.findFirst({
    where: { estimateVersionId, optionId, name: data.name, groupLabel: data.groupLabel ?? null },
  });
  if (existing) return existing;
  return addSection(estimateVersionId, { ...data, optionId });
}

// An alternate/upgrade pricing path within one estimate (business-
// rules.md/data-model-v0.md's Option, direct port of the OPTION sheet
// pattern) -- priced separately from the base estimate via
// computeOptionTotal below, not folded into computeVersionTotals.
export async function addOption(estimateVersionId: string, data: { name: string; sortOrder?: number }) {
  await assertUnlocked(estimateVersionId);
  return db.option.create({
    data: {
      estimateVersionId,
      name: data.name,
      sortOrder: data.sortOrder ?? 0,
    },
  });
}

export function computeOptionTotal(sections: { lineItems: { totalCost: DecimalInput; isDraft?: boolean }[] }[]): Decimal {
  return sections.reduce((sum, section) => sum.plus(computeSectionTotal(section.lineItems)), new Prisma.Decimal(0));
}

// Groups a freeform, cross-category set of an EstimateVersion's own
// LineItems as "going out to bid" to one vendor -- see schema.prisma's
// BidPackage comment for why this is a real model (mirrors Option's own
// shape) rather than a bare string field, and why membership is a single
// nullable FK on LineItem rather than a join table. lineItemIds is
// verified against estimateVersionId here, not trusted from the caller
// alone -- the same cross-resource gap deleteLineItem's header comment
// describes, just checked against a whole set instead of one id.
export async function createBidPackage(
  estimateVersionId: string,
  data: { name: string; vendorName?: string | null; lineItemIds: string[] },
) {
  await assertUnlocked(estimateVersionId);
  if (data.lineItemIds.length === 0) throw new Error("Select at least one line item for this bid package.");

  const ownedCount = await db.lineItem.count({
    where: { id: { in: data.lineItemIds }, section: { estimateVersionId } },
  });
  if (ownedCount !== data.lineItemIds.length) {
    throw new Error("One or more selected line items don't belong to this estimate version.");
  }

  return db.$transaction(async (tx) => {
    const bidPackage = await tx.bidPackage.create({
      data: { estimateVersionId, name: data.name, vendorName: data.vendorName ?? null },
    });
    await tx.lineItem.updateMany({
      where: { id: { in: data.lineItemIds } },
      data: { bidPackageId: bidPackage.id },
    });
    return bidPackage;
  });
}

// opportunityId ownership check -- see deleteLineItem's header comment.
export async function removeLineItemFromBidPackage(opportunityId: string, lineItemId: string) {
  const existing = await db.lineItem.findFirstOrThrow({
    where: { id: lineItemId, section: { estimateVersion: { estimate: { opportunityId } } } },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);
  return db.lineItem.update({ where: { id: lineItemId }, data: { bidPackageId: null } });
}

export async function setBidPackageStatus(bidPackageId: string, status: BidPackageStatus) {
  return db.bidPackage.update({ where: { id: bidPackageId }, data: { status } });
}

// Shared by every LineItem CRUD function below -- see LineItemAuditLog's
// own schema comment for why lineItemId is never a live FK (must survive
// deleteLineItem's real hard delete) and why actorId is optional (most of
// this file's ~18 call sites are import/AI pipelines with no real user
// session, and null is the honest answer there, not a fabricated one).
async function recordLineItemAudit(
  estimateVersionId: string,
  action: LineItemAuditAction,
  description: string,
  actorId: string | null,
  detail: Prisma.InputJsonValue | undefined,
  lineItemId: string | null = null,
) {
  await db.lineItemAuditLog.create({
    data: { estimateVersionId, lineItemId, description, action, detail, actorId },
  });
}

// estimateVersionId is the caller's already-verified version (see
// opportunity-access.ts's assertVersionBelongsToEstimate) -- sectionId
// alone doesn't prove it belongs to that version, the same cross-
// resource gap deleteLineItem's header comment describes.
export async function addLineItem(
  estimateVersionId: string,
  sectionId: string,
  data: {
    lineType: LineItemType;
    description: string;
    department?: string | null;
    // Proposal-facing grouping -- see line-item-category.ts. Optional
    // here since a manually added line item's category is whatever the
    // estimator picked in the form, which may be left unset.
    category?: string | null;
    // A real $0 by design (client already owns/supplies it) vs. simply not
    // yet priced -- see line-item-category.ts's inferIsClientOwned.
    isClientOwned?: boolean;
    // Manual disambiguation for a genuinely ambiguous material (PVC, for
    // one) -- see LineItemUsageTag's own schema comment. Never inferred,
    // unlike category/isClientOwned above.
    usageTag?: LineItemUsageTag | null;
    qty: DecimalInput;
    unit?: string | null;
    unitCost: DecimalInput;
    // Phase 4 design-intake prototype: a draft line item references the
    // Attachment (design pull sheet) it was drafted from and is excluded
    // from cost rollups until confirmDraftLineItem below.
    isDraft?: boolean;
    attachmentId?: string | null;
  },
  actorId?: string | null,
) {
  const section = await db.estimateSection.findFirstOrThrow({ where: { id: sectionId, estimateVersionId } });
  await assertUnlocked(section.estimateVersionId);

  const created = await db.lineItem.create({
    data: {
      sectionId,
      lineType: data.lineType,
      description: data.description,
      department: data.department ?? null,
      category: data.category ?? null,
      isClientOwned: data.isClientOwned ?? false,
      usageTag: data.usageTag ?? null,
      qty: new Prisma.Decimal(data.qty),
      unit: data.unit ?? null,
      unitCost: new Prisma.Decimal(data.unitCost),
      totalCost: computeLineItemTotal(data.qty, data.unitCost),
      isDraft: data.isDraft ?? false,
      attachmentId: data.attachmentId ?? null,
    },
  });
  await recordLineItemAudit(
    estimateVersionId,
    "CREATE",
    created.description,
    actorId ?? null,
    { qty: created.qty.toString(), unitCost: created.unitCost.toString(), category: created.category },
    created.id,
  );
  return created;
}

// Phase 7.1: bulk insert for document-sourced imports (a real pricing
// schedule runs ~185 rows -- see data/RFP/superbowl). One $transaction +
// one recomputeVersionTotals call at the end, rather than looping
// addLineItem's single-row create + implicit per-row totals recompute
// callers do today (see addLineItemAction). Every row defaults to
// isDraft: true -- still needs a human review step before it counts
// toward committed pricing -- unless a caller explicitly opts out via
// options.isDraft: false, e.g. bid-package-actions.ts's
// commitProposedVendorSectionAction, where accepting the proposal *is*
// the review step (same posture applyVendorMatchAction already
// established for an existing-candidate match).
export async function addLineItemsBulk(
  estimateVersionId: string,
  sectionId: string,
  items: {
    lineType: LineItemType;
    description: string;
    department?: string | null;
    category?: string | null;
    isClientOwned?: boolean;
    usageTag?: LineItemUsageTag | null;
    qty: DecimalInput;
    unit?: string | null;
    unitCost: DecimalInput;
    documentId: string;
    // The exact source text this row came from -- a pricing-schedule
    // row's own verbatim cell text, or an AI-proposed item's quote
    // (already verified against the real extracted text by the caller).
    // Powers the "Source" link in the estimate line item list
    // (document-view page.tsx's citation/highlight mechanism) so a
    // reviewer can check every priced row against hard data, not just
    // trust it. Undefined for a manually added row -- there's no
    // document to check it against.
    sourceQuote?: string | null;
    sourcePageNumber?: number | null;
    // A vendor/RFP-assigned code for this exact row (e.g. "CAM-01") when
    // the source pricing schedule carries one -- see LineItem.positionCode's
    // own schema comment for what this unlocks in bid-package matching.
    positionCode?: string | null;
  }[],
  options?: { isDraft?: boolean; bidPackageId?: string | null },
  actorId?: string | null,
) {
  await assertUnlocked(estimateVersionId);
  if (items.length === 0) return [];

  const isDraft = options?.isDraft ?? true;
  // Prisma's array form of $transaction resolves in the same order as
  // the input array -- returned directly instead of a findMany() re-query
  // afterward, since a caller (commitProposedVendorSectionAction) needs
  // each created row to line up index-for-index with its own input item,
  // which an unordered-by-default findMany can't guarantee.
  const created = await db.$transaction(
    items.map((item) =>
      db.lineItem.create({
        data: {
          sectionId,
          lineType: item.lineType,
          description: item.description,
          department: item.department ?? null,
          category: item.category ?? null,
          isClientOwned: item.isClientOwned ?? false,
          usageTag: item.usageTag ?? null,
          qty: new Prisma.Decimal(item.qty),
          unit: item.unit ?? null,
          unitCost: new Prisma.Decimal(item.unitCost),
          totalCost: computeLineItemTotal(item.qty, item.unitCost),
          isDraft,
          documentId: item.documentId,
          sourceQuote: item.sourceQuote ?? null,
          sourcePageNumber: item.sourcePageNumber ?? null,
          positionCode: item.positionCode ?? null,
          bidPackageId: options?.bidPackageId ?? null,
        },
      }),
    ),
  );

  await recomputeVersionTotals(estimateVersionId);
  // One summary row for the whole batch, not one per item -- a real
  // import already lands hundreds of rows in one call (see this
  // function's own header comment), and per-item logging here would
  // flood the log with noise nobody would actually read.
  await recordLineItemAudit(
    estimateVersionId,
    "CREATE",
    `Bulk import: ${created.length} item${created.length === 1 ? "" : "s"}`,
    actorId ?? null,
    { count: created.length, documentId: items[0]?.documentId ?? null },
  );
  return created;
}

// opportunityId is the caller's already-access-checked opportunity, NOT
// trusted from lineItemId alone -- see deleteLineItem's header comment.
export async function updateLineItem(
  opportunityId: string,
  lineItemId: string,
  data: {
    description?: string;
    lineType?: LineItemType;
    department?: string | null;
    category?: string | null;
    isClientOwned?: boolean;
    usageTag?: LineItemUsageTag | null;
    qty?: DecimalInput;
    unit?: string | null;
    unitCost?: DecimalInput;
    // Provenance for an applied vendor-quote match (bid-package-actions.ts's
    // applyVendorMatchAction) -- same fields addLineItemsBulk already
    // stamps on a document-sourced row, just settable on an EXISTING row
    // here instead of only at creation. isDraft flips to false on apply:
    // the vendor-match review the user just did *is* the human-review
    // step, not a separate confirmDraftLineItem click after it.
    documentId?: string | null;
    sourceQuote?: string | null;
    isDraft?: boolean;
    // Also settable here for the same reason as documentId/sourceQuote
    // above: applyVendorMatchAction can now apply a vendor price to ANY
    // line item on the current estimate version, not just ones already
    // added to this bid package (see its own header comment) -- applying
    // a match is what adds it.
    bidPackageId?: string | null;
    // Per-item Proposal PDF visibility -- see LineItem.includeInProposal's
    // own schema comment. A hidden EstimateSection hides this regardless
    // of the value here.
    includeInProposal?: boolean;
  },
  actorId?: string | null,
) {
  const existing = await db.lineItem.findFirstOrThrow({
    where: { id: lineItemId, section: { estimateVersion: { estimate: { opportunityId } } } },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);

  const qty = data.qty ?? existing.qty;
  const unitCost = data.unitCost ?? existing.unitCost;

  const resolved = {
    description: data.description ?? existing.description,
    lineType: data.lineType ?? existing.lineType,
    department: data.department !== undefined ? data.department : existing.department,
    category: data.category !== undefined ? data.category : existing.category,
    isClientOwned: data.isClientOwned ?? existing.isClientOwned,
    usageTag: data.usageTag !== undefined ? data.usageTag : existing.usageTag,
    qty: new Prisma.Decimal(qty),
    unit: data.unit !== undefined ? data.unit : existing.unit,
    unitCost: new Prisma.Decimal(unitCost),
    totalCost: computeLineItemTotal(qty, unitCost),
    documentId: data.documentId !== undefined ? data.documentId : existing.documentId,
    sourceQuote: data.sourceQuote !== undefined ? data.sourceQuote : existing.sourceQuote,
    isDraft: data.isDraft ?? existing.isDraft,
    bidPackageId: data.bidPackageId !== undefined ? data.bidPackageId : existing.bidPackageId,
    includeInProposal: data.includeInProposal ?? existing.includeInProposal,
  };

  // Only the fields that actually changed -- a re-save with identical
  // values (a common no-op form submit) writes no audit row at all,
  // rather than flooding the log with entries that say nothing happened.
  const changes: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(resolved) as (keyof typeof resolved)[]) {
    const before = existing[key];
    const after = resolved[key];
    const changed = before instanceof Prisma.Decimal ? !before.equals(after as Prisma.Decimal) : before !== after;
    if (changed) {
      changes[key] = {
        before: before instanceof Prisma.Decimal ? before.toString() : before,
        after: after instanceof Prisma.Decimal ? after.toString() : after,
      };
    }
  }

  const updated = await db.lineItem.update({ where: { id: lineItemId }, data: resolved });
  if (Object.keys(changes).length > 0) {
    await recordLineItemAudit(
      existing.section.estimateVersionId,
      "UPDATE",
      updated.description,
      actorId ?? null,
      changes as Prisma.InputJsonValue,
      updated.id,
    );
  }
  return updated;
}

// Same swap-with-neighbor-then-renumber-all approach as moveSectionOrder,
// scoped to line items sharing this item's sectionId (production-tracking
// order within a COMPONENT/CATEGORY-type section) -- unrelated to
// `category`, the client-facing proposal grouping, which this never
// touches.
// opportunityId ownership check -- see deleteLineItem's header comment.
export async function moveLineItemWithinSection(
  opportunityId: string,
  lineItemId: string,
  direction: "up" | "down",
  // The exact ordered ids of every row the UI is showing alongside
  // lineItemId right now -- LineItemsTable's own `lineItems` array
  // (whatever category/method bucket produced it), NOT re-derived here
  // from a blind sectionId query. One EstimateSection routinely holds
  // line items whose resolved category (LineItem.category) differs
  // per-item -- a booth's items commonly span Structure, Flooring,
  // Custom Build, etc. all under one section row (see
  // resolveEffectiveCategory) -- so re-deriving "siblings" from the
  // whole section meant the two rows a user was actually looking at in
  // one category tab were very often NOT adjacent in that raw,
  // cross-category sequence: clicking the button swapped the clicked
  // row with some entirely different, invisible-in-this-tab item
  // elsewhere in the section instead, making the button appear to do
  // nothing. Confirmed live and reproduced exactly: a 2-item Custom
  // Build/Rental view inside a 32-item mixed section, where index+1 in
  // the RAW order was a Structure-category door, not the other visible
  // Custom Build row.
  visibleSiblingIds: string[],
) {
  const item = await db.lineItem.findFirstOrThrow({
    where: { id: lineItemId, section: { estimateVersion: { estimate: { opportunityId } } } },
    include: { section: true },
  });
  await assertUnlocked(item.section.estimateVersionId);

  const index = visibleSiblingIds.indexOf(lineItemId);
  if (index === -1) return;
  const swapWithIndex = direction === "up" ? index - 1 : index + 1;
  if (swapWithIndex < 0 || swapWithIndex >= visibleSiblingIds.length) return;
  const swapWithId = visibleSiblingIds[swapWithIndex];

  // Re-verified against the DB rather than trusted outright from the
  // caller-supplied list -- both rows must actually belong to this exact
  // section, the same ownership discipline as every other
  // caller-supplied-ID check in this file (see opportunity-access.ts's
  // own header comment on the general pattern).
  const pair = await db.lineItem.findMany({
    where: { id: { in: [lineItemId, swapWithId] }, sectionId: item.sectionId },
    select: { id: true, sortOrder: true },
  });
  const a = pair.find((p) => p.id === lineItemId);
  const b = pair.find((p) => p.id === swapWithId);
  if (!a || !b) return;

  // A plain two-value swap -- not a renumber of the whole section --
  // so every OTHER item's sortOrder (visible in this bucket or not)
  // stays exactly where it was.
  await db.$transaction([
    db.lineItem.update({ where: { id: a.id }, data: { sortOrder: b.sortOrder } }),
    db.lineItem.update({ where: { id: b.id }, data: { sortOrder: a.sortOrder } }),
  ]);
}

// The missing primitive for the line-item-audit-service.ts "move to the
// correct project" fix -- moveLineItemWithinSection only reorders inside
// one section, and nothing else in this file changes a LineItem's
// sectionId. Reuses findOrCreateSection so a target estimate that already
// has a same-named section (the common case -- both estimates' documents
// were classified against the same fixed SCOPE_CATEGORIES list) gets the
// item merged in rather than a duplicate section created. Both versions'
// totals change, so both get recomputed, not just the destination.
// opportunityId ownership check on BOTH ends of the move -- see
// deleteLineItem's header comment. Without this, a caller authorized for
// opportunityId could move a line item OUT of an estimate they have no
// access to (via lineItemId alone), or move one of their own items INTO
// an estimate under a different opportunity entirely (via
// targetEstimateId alone) -- both directions need the same check, not
// just the source.
export async function moveLineItemToEstimate(opportunityId: string, lineItemId: string, targetEstimateId: string) {
  const lineItem = await db.lineItem.findFirstOrThrow({
    where: { id: lineItemId, section: { estimateVersion: { estimate: { opportunityId } } } },
    include: { section: true },
  });
  const fromEstimateVersionId = lineItem.section.estimateVersionId;
  await assertUnlocked(fromEstimateVersionId);

  const targetEstimate = await db.estimate.findFirstOrThrow({ where: { id: targetEstimateId, opportunityId } });
  const targetVersion = await db.estimateVersion.findFirstOrThrow({
    where: { estimateId: targetEstimate.id, isCurrent: true },
  });
  await assertUnlocked(targetVersion.id);

  const existingCount = await db.estimateSection.count({
    where: { estimateVersionId: targetVersion.id, optionId: null },
  });
  const targetSection = await findOrCreateSection(targetVersion.id, {
    name: lineItem.section.name,
    sectionType: lineItem.section.sectionType,
    groupLabel: lineItem.section.groupLabel,
    sortOrder: existingCount,
  });

  await db.lineItem.update({ where: { id: lineItemId }, data: { sectionId: targetSection.id } });
  await recomputeVersionTotals(fromEstimateVersionId);
  await recomputeVersionTotals(targetVersion.id);

  return { fromEstimateVersionId, toEstimateVersionId: targetVersion.id };
}

// Sets archivedAt, NOT deletedAt -- see the field's own schema.prisma
// comment. Hides this estimate from the active Estimates lists (the
// Opportunity page, the global /estimates index) while leaving it fully
// viewable (documents, line items, proposals) and restorable; edits are
// rejected by assertEstimateNotArchived until unarchiveEstimate runs.
export async function archiveEstimate(id: string) {
  return db.estimate.update({ where: { id }, data: { archivedAt: new Date() } });
}

export async function unarchiveEstimate(id: string) {
  return db.estimate.update({ where: { id }, data: { archivedAt: null } });
}

// opportunityId is the caller's already-access-checked opportunity (from
// requireOpportunityAccess/requireEstimateAccess, via
// opportunity-access.ts's estimateOpportunityId when only an estimateId
// is in scope), NOT trusted from lineItemId alone -- lineItemId is an
// opaque, guessable/enumerable string a caller supplies directly, and
// without confirming it actually belongs to the opportunity the caller
// was authorized for, any authenticated user with access to SOME
// opportunity could mutate or delete another company's pricing data by
// ID alone. This is called from two different callers with two different
// natural scoping keys (estimates/actions.ts has an estimateId,
// line-item-audit-actions.ts only has an opportunityId since a
// misattributed item's actual estimate isn't known in advance) --
// opportunityId is the one boundary both can supply, and it's the app's
// real access-control axis (see opportunity-access.ts's own header
// comment): SystemRole answers "admin area or not," this answers "can
// this user see this opportunity and everything under it."
// Every field restoreLineItem needs to put the row back exactly as it
// was -- sectionId/sortOrder are what make "restored to the same
// location" real rather than just "restored to the bottom of wherever."
// Kept as its own named shape (not just `typeof existing`) since this is
// a serialization contract: Decimal fields go to string, and it's read
// back out of a loosely-typed Json column by restoreLineItem, in a
// different function, potentially a long time later.
interface LineItemDeleteSnapshot {
  sectionId: string;
  sortOrder: number;
  lineType: LineItemType;
  department: string | null;
  category: string | null;
  isClientOwned: boolean;
  usageTag: LineItemUsageTag | null;
  qty: string;
  unit: string | null;
  unitCost: string;
  totalCost: string;
  isDraft: boolean;
  attachmentId: string | null;
  documentId: string | null;
  sourceQuote: string | null;
  sourcePageNumber: number | null;
  positionCode: string | null;
  bidPackageId: string | null;
}

export async function deleteLineItem(opportunityId: string, lineItemId: string, actorId?: string | null) {
  const existing = await db.lineItem.findFirstOrThrow({
    where: { id: lineItemId, section: { estimateVersion: { estimate: { opportunityId } } } },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);
  // Captured BEFORE the delete -- this snapshot is the only remaining
  // record of the row once it's gone (LineItemAuditLog.lineItemId is
  // deliberately not a live FK, see its own schema comment), and the
  // only thing restoreLineItem below has to work from.
  const snapshot: LineItemDeleteSnapshot = {
    sectionId: existing.sectionId,
    sortOrder: existing.sortOrder,
    lineType: existing.lineType,
    department: existing.department,
    category: existing.category,
    isClientOwned: existing.isClientOwned,
    usageTag: existing.usageTag,
    qty: existing.qty.toString(),
    unit: existing.unit,
    unitCost: existing.unitCost.toString(),
    totalCost: existing.totalCost.toString(),
    isDraft: existing.isDraft,
    attachmentId: existing.attachmentId,
    documentId: existing.documentId,
    sourceQuote: existing.sourceQuote,
    sourcePageNumber: existing.sourcePageNumber,
    positionCode: existing.positionCode,
    bidPackageId: existing.bidPackageId,
  };
  const deleted = await db.lineItem.delete({ where: { id: lineItemId } });
  await recordLineItemAudit(
    existing.section.estimateVersionId,
    "DELETE",
    existing.description,
    actorId ?? null,
    snapshot as unknown as Prisma.InputJsonValue,
    lineItemId,
  );
  return { ...deleted, estimateVersionId: existing.section.estimateVersionId };
}

// Puts a deleted line item back using its own DELETE audit row's
// snapshot -- same section, same sortOrder (so it lands back among the
// same neighbors it had, not at the bottom of the list), same everything
// else, UNLESS the original section itself no longer exists (see the
// fallback-section branch below), in which case it lands in a shared
// recovery section instead of failing outright. Restores with its
// ORIGINAL id (Prisma allows an explicit value
// for an @default(cuid()) field on create) rather than a fresh one, so
// any existing citation link pointing at #line-item-<id> (chat mentions,
// vendor-match history, cost-actual records) resolves again instead of
// silently pointing at a row that no longer exists.
//
// opportunityId ownership check -- see deleteLineItem's own header
// comment for why this is the boundary, not lineItemId/auditLogId alone.
export async function restoreLineItem(opportunityId: string, auditLogId: string, actorId?: string | null) {
  const entry = await db.lineItemAuditLog.findFirstOrThrow({
    where: { id: auditLogId, action: "DELETE", estimateVersion: { estimate: { opportunityId } } },
  });
  if (!entry.lineItemId || !entry.detail || typeof entry.detail !== "object") {
    throw new Error("This deletion has no restorable snapshot.");
  }
  // A pre-restore-feature DELETE row (recorded before this snapshot was
  // widened to include location) has neither field -- rather than
  // restore it to a guessed, possibly-wrong section, refuse outright.
  const snapshot = entry.detail as unknown as Partial<LineItemDeleteSnapshot>;
  if (!snapshot.sectionId || snapshot.sortOrder === undefined) {
    throw new Error("This deletion predates the restore feature and can't be restored automatically.");
  }

  const alreadyRestored = await db.lineItem.findUnique({ where: { id: entry.lineItemId } });
  if (alreadyRestored) {
    throw new Error("This line item has already been restored.");
  }

  await assertUnlocked(entry.estimateVersionId);

  let section = await db.estimateSection.findFirst({
    where: { id: snapshot.sectionId, estimateVersionId: entry.estimateVersionId },
  });
  if (!section) {
    // The original section is gone, not just this one item -- most often
    // a whole H1/H2 group deleted at once (deleteElementGroup hard-deletes
    // its EstimateSection rows alongside every one of its line items, see
    // that function's own comment), which used to make every one of those
    // otherwise-perfectly-restorable items permanently unrestorable: this
    // same "no longer exists" error, on every single one, forever, with no
    // path forward. LineItemDeleteSnapshot never captured the section's
    // own name/groupLabel (only sectionId/sortOrder), so the ORIGINAL
    // section can't be reconstructed -- this lands the item in a shared
    // recovery section instead, named after the missing sectionId so every
    // item that pointed at the SAME deleted section (i.e. the same
    // deleted group) finds and reuses the one already created for it
    // rather than each getting its own. An estimator can rename/move it
    // once restored; the alternative (refusing forever) is strictly worse.
    const fallbackName = `Recovered items (deleted section ${snapshot.sectionId.slice(-8)})`;
    section = await db.estimateSection.findFirst({
      where: { estimateVersionId: entry.estimateVersionId, name: fallbackName },
    });
    section ??= await db.estimateSection.create({
      data: { estimateVersionId: entry.estimateVersionId, name: fallbackName, sectionType: "COMPONENT" },
    });
  }

  const restored = await db.lineItem.create({
    data: {
      id: entry.lineItemId,
      sectionId: section.id,
      sortOrder: snapshot.sortOrder,
      lineType: snapshot.lineType!,
      description: entry.description,
      department: snapshot.department ?? null,
      category: snapshot.category ?? null,
      isClientOwned: snapshot.isClientOwned ?? false,
      usageTag: snapshot.usageTag ?? null,
      qty: new Prisma.Decimal(snapshot.qty!),
      unit: snapshot.unit ?? null,
      unitCost: new Prisma.Decimal(snapshot.unitCost!),
      totalCost: new Prisma.Decimal(snapshot.totalCost!),
      isDraft: snapshot.isDraft ?? false,
      attachmentId: snapshot.attachmentId ?? null,
      documentId: snapshot.documentId ?? null,
      sourceQuote: snapshot.sourceQuote ?? null,
      sourcePageNumber: snapshot.sourcePageNumber ?? null,
      positionCode: snapshot.positionCode ?? null,
      bidPackageId: snapshot.bidPackageId ?? null,
    },
  });
  await recordLineItemAudit(
    entry.estimateVersionId,
    "RESTORE",
    restored.description,
    actorId ?? null,
    { restoredFromAuditLogId: entry.id },
    restored.id,
  );
  return { ...restored, estimateVersionId: entry.estimateVersionId };
}

// Marks a draft line item (Phase 4 design-intake prototype) as
// human-reviewed and priced -- migration-plan.md's "human-reviewed
// before pricing" -- so it starts counting toward the version's totals.
// opportunityId ownership check -- see deleteLineItem's header comment.
export async function confirmDraftLineItem(opportunityId: string, lineItemId: string) {
  const existing = await db.lineItem.findFirstOrThrow({
    where: { id: lineItemId, section: { estimateVersion: { estimate: { opportunityId } } } },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);
  await db.lineItem.update({ where: { id: lineItemId }, data: { isDraft: false } });
  await recomputeVersionTotals(existing.section.estimateVersionId);
  return db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
}

// Bulk sibling of confirmDraftLineItem above -- a real pricing schedule
// import can land hundreds of draft rows in one commit (a 13-file booth
// workbook batch landed 786 on one real estimate), and clicking the
// per-row confirm button that many times isn't realistic. Same
// opportunityId ownership check and locked-version guard as the
// single-item version; returns how many rows it actually flipped so the
// caller can show a real count instead of a silent no-op.
export async function confirmAllDraftLineItems(opportunityId: string, estimateVersionId: string) {
  await assertUnlocked(estimateVersionId);
  const result = await db.lineItem.updateMany({
    where: {
      isDraft: true,
      section: { estimateVersionId, estimateVersion: { estimate: { opportunityId } } },
    },
    data: { isDraft: false },
  });
  if (result.count > 0) await recomputeVersionTotals(estimateVersionId);
  return result.count;
}

// One-time-per-import-bug repair: re-resolves the category of any
// LineItem stuck at "Other" (or unset) using the same priority chain
// design-cost-estimate-import-service.ts's commit now uses -- the
// workbook's own banner-row category (recovered via
// EstimateSection.name, which findOrCreateSection sets to that same raw
// label, e.g. "Wall Panels", "BeMatrix") first, then a catalog match,
// then the description heuristic. Exists because the bug this backfills
// affected already-committed LineItems that the parser fix alone can't
// reach -- new imports get it right automatically, but ~527 rows already
// written to a real estimate before the fix needed this to catch up.
// Safe to run broadly: mapDesignCostCategoryToCanonical only ever matches
// this workbook format's own exact banner strings, so a section named
// anything else (a flat pricing-schedule's or AI-proposed section) just
// falls through unchanged.
export async function recategorizeLineItems(opportunityId: string, estimateVersionId: string) {
  await assertUnlocked(estimateVersionId);
  const categories = await db.category.findMany({ where: { deletedAt: null } });
  const lineItems = await db.lineItem.findMany({
    where: {
      OR: [{ category: null }, { category: "Other" }],
      section: { estimateVersionId, estimateVersion: { estimate: { opportunityId } } },
    },
    include: { section: true },
  });

  let updated = 0;
  for (const li of lineItems) {
    const resolved =
      mapDesignCostCategoryToCanonical(li.section.name, categories) ??
      inferCategoryFromDescription(li.description, categories);
    if (resolved && resolved !== li.category) {
      await db.lineItem.update({ where: { id: li.id }, data: { category: resolved } });
      updated++;
    }
  }
  return { checked: lineItems.length, updated };
}

// Attachment is a reference (filename, or an external FTP/WeTransfer
// link), not an uploaded file -- schema.prisma's Attachment comment.
export async function addAttachment(
  estimateId: string,
  data: { fileRef: string; uploadedById?: string | null },
) {
  return db.attachment.create({
    data: { estimateId, fileRef: data.fileRef, uploadedById: data.uploadedById ?? null },
  });
}

// Per-row margin target is a user-editable input (business-rules.md Rule
// 6's "Price Summary!J125 is a legitimate estimator input, not a
// hardcoded system constant"). Recomputes grandTotal/grossMarginPct
// immediately so the UI reflects the new target without a separate save.
export async function updateMarginTarget(estimateVersionId: string, marginTargetPct: DecimalInput) {
  await assertUnlocked(estimateVersionId);
  await db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: { marginTargetPct: new Prisma.Decimal(marginTargetPct) },
  });
  return recomputeVersionTotals(estimateVersionId);
}

// Shared by recomputeVersionTotals/lockEstimateVersion below -- both need
// the live category list and this version's own margin overrides
// alongside the version itself to gross up per line item instead of once
// over the whole version's cost.
async function fetchCategoriesAndMarginOverrides(estimateVersionId: string) {
  const [categories, overrides] = await Promise.all([
    db.category.findMany({ where: { deletedAt: null } }),
    db.categoryMarginOverride.findMany({ where: { estimateVersionId } }),
  ]);
  const overridesByCategoryId = new Map(overrides.map((o) => [o.categoryId, o.marginPct]));
  return { categories, overridesByCategoryId };
}

// Recomputes and persists totalCost/grandTotal/grossMarginPct without
// locking -- lets the UI show a live-updating grand total as line items
// change, per task #38's "live-computed totals."
export async function recomputeVersionTotals(estimateVersionId: string) {
  const [version, { categories, overridesByCategoryId }] = await Promise.all([
    db.estimateVersion.findUniqueOrThrow({ where: { id: estimateVersionId }, include: VERSION_WITH_TOTALS_INCLUDE }),
    fetchCategoriesAndMarginOverrides(estimateVersionId),
  ]);

  const totals = computeVersionTotals(version, categories, overridesByCategoryId);

  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: totals,
  });
}

// Immutable once locked (schema.prisma's EstimateVersion comment) --
// freezes totals and flips isLocked so addSection/addLineItem/etc. above
// start rejecting further edits.
export async function lockEstimateVersion(estimateVersionId: string) {
  const [version, { categories, overridesByCategoryId }] = await Promise.all([
    db.estimateVersion.findUniqueOrThrow({ where: { id: estimateVersionId }, include: VERSION_WITH_TOTALS_INCLUDE }),
    fetchCategoriesAndMarginOverrides(estimateVersionId),
  ]);
  if (version.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is already locked.`);
  }

  const totals = computeVersionTotals(version, categories, overridesByCategoryId);

  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: { ...totals, isLocked: true, lockedAt: new Date() },
  });
}

// Sets (or replaces) this version's margin override for one category --
// upsert since an estimator adjusting an already-overridden category's %
// is the common case, not just the first-time set. Deleting the row (see
// clearCategoryMarginOverride below), not writing a sentinel/null
// marginPct, is how an override reverts a category back to inheriting the
// document's own target -- keeps resolveLineItemMarginPct's own lookup a
// plain "does a row exist" check.
export async function setCategoryMarginOverride(estimateVersionId: string, categoryId: string, marginPct: DecimalInput) {
  await assertUnlocked(estimateVersionId);
  await db.categoryMarginOverride.upsert({
    where: { estimateVersionId_categoryId: { estimateVersionId, categoryId } },
    create: { estimateVersionId, categoryId, marginPct: new Prisma.Decimal(marginPct) },
    update: { marginPct: new Prisma.Decimal(marginPct) },
  });
  await recomputeVersionTotals(estimateVersionId);
}

export async function clearCategoryMarginOverride(estimateVersionId: string, categoryId: string) {
  await assertUnlocked(estimateVersionId);
  await db.categoryMarginOverride.deleteMany({ where: { estimateVersionId, categoryId } });
  await recomputeVersionTotals(estimateVersionId);
}

// Top tier of the three-level Proposal PDF copy system -- see
// EstimateCategorySummary's own schema comment. Same upsert-on-compound-
// key shape as setCategoryMarginOverride above (a row doesn't exist until
// the first summary is written for this version+category pair), but
// never touches totals, unlike that one.
export async function updateCategorySummary(estimateVersionId: string, categoryId: string, summary: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateCategorySummary.upsert({
    where: { estimateVersionId_categoryId: { estimateVersionId, categoryId } },
    create: { estimateVersionId, categoryId, summary },
    update: { summary, pendingSummary: null },
  });
}

export async function clearCategoryPendingSummary(estimateVersionId: string, categoryId: string) {
  await assertUnlocked(estimateVersionId);
  await db.estimateCategorySummary.updateMany({
    where: { estimateVersionId, categoryId },
    data: { pendingSummary: null },
  });
}

function lineItemCreateData(li: {
  lineType: LineItemType;
  description: string;
  department: string | null;
  qty: Decimal;
  unitCost: Decimal;
  totalCost: Decimal;
}) {
  return {
    lineType: li.lineType,
    description: li.description,
    department: li.department,
    qty: li.qty,
    unitCost: li.unitCost,
    totalCost: li.totalCost,
    // isDraft/attachmentId deliberately not copied -- a new version starts
    // with only confirmed line items, matching lockEstimateVersion's own
    // totals (which already excluded drafts).
  };
}

// Duplicates a locked version's sections/line items -- AND its Options,
// each with their own sections/line items -- into a fresh unlocked
// version rather than mutating history -- the "Create new version" flow
// schema.prisma's EstimateVersion comment describes. An interactive
// transaction, not the array form used elsewhere in this file, because
// each Option's sections need the new version's id AND a newly-created
// Option's id, both of which only exist after earlier steps in this same
// transaction complete.
export async function createNewVersionFromLocked(estimateVersionId: string) {
  const source = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: {
      sections: { where: { optionId: null }, include: { lineItems: true } },
      options: { include: { sections: { include: { lineItems: true } } } },
      categoryMarginOverrides: true,
      estimate: { select: { id: true, archivedAt: true } },
    },
  });
  if (!source.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is not locked; only locked versions can be copied.`);
  }
  assertEstimateNotArchived(source.estimate);

  return db.$transaction(async (tx) => {
    await tx.estimateVersion.update({ where: { id: source.id }, data: { isCurrent: false } });

    const created = await tx.estimateVersion.create({
      data: {
        estimateId: source.estimateId,
        versionNumber: source.versionNumber + 1,
        marginTargetPct: source.marginTargetPct,
        // Sections/line items are an exact copy of source (below), so its
        // already-computed totals carry over too -- otherwise the new
        // version would show $0 until its first edit.
        totalCost: source.totalCost,
        grandTotal: source.grandTotal,
        grossMarginPct: source.grossMarginPct,
        isCurrent: true,
        isLocked: false,
        sections: {
          create: source.sections.map((section) => ({
            name: section.name,
            sectionType: section.sectionType,
            sortOrder: section.sortOrder,
            lineItems: { create: section.lineItems.map(lineItemCreateData) },
          })),
        },
      },
    });

    for (const option of source.options) {
      await tx.option.create({
        data: {
          estimateVersionId: created.id,
          name: option.name,
          sortOrder: option.sortOrder,
          sections: {
            create: option.sections.map((section) => ({
              estimateVersionId: created.id,
              name: section.name,
              sectionType: section.sectionType,
              sortOrder: section.sortOrder,
              lineItems: { create: section.lineItems.map(lineItemCreateData) },
            })),
          },
        },
      });
    }

    // Category margin overrides are a per-version estimator decision, same
    // as marginTargetPct above -- carried forward so the new version
    // starts priced the same way the locked one was, not reset to the
    // document target for every category on every new version.
    if (source.categoryMarginOverrides.length > 0) {
      await tx.categoryMarginOverride.createMany({
        data: source.categoryMarginOverrides.map((o) => ({
          estimateVersionId: created.id,
          categoryId: o.categoryId,
          marginPct: o.marginPct,
        })),
      });
    }

    return created;
  });
}
