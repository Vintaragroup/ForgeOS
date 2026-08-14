// Framework-agnostic estimate math + mutations, kept separate from any
// future app/estimates/actions.ts the same way opportunity-service.ts is
// kept separate from app/opportunities/actions.ts (see that file's header
// comment). The pure compute functions below have no db dependency at all
// and are the part docs/migration-plan.md's Phase 3 scope calls out by
// name: "Implement the margin gross-up formula with a regression test
// guarding against a markup-formula substitution."

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { LineItemType, SectionType } from "@/generated/prisma/enums";

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

// Mirrors Price Summary!J130/J131 ("GROSS MARGIN" = (sell-cost)/sell)
// rather than just echoing marginTargetPct back -- computing it
// independently is a sanity check that grandTotal was actually derived by
// gross-up, not some other path.
export function computeVersionTotals(version: {
  marginTargetPct: DecimalInput;
  sections: { lineItems: { totalCost: DecimalInput }[] }[];
}): VersionTotals {
  const totalCost = version.sections.reduce(
    (sum, section) => sum.plus(computeSectionTotal(section.lineItems)),
    new Prisma.Decimal(0),
  );
  const grandTotal = computeMarginGrossUp(totalCost, version.marginTargetPct);
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

export async function assertUnlocked(estimateVersionId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
  });
  if (version.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is locked and cannot be edited.`);
  }
  return version;
}

export async function createEstimateVersion(estimateId: string, marginTargetPct: DecimalInput = 0) {
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
  data: { name: string; sectionType: SectionType; sortOrder?: number; optionId?: string; groupLabel?: string | null },
) {
  await assertUnlocked(estimateVersionId);
  return db.estimateSection.create({
    data: {
      estimateVersionId,
      name: data.name,
      sectionType: data.sectionType,
      sortOrder: data.sortOrder ?? 0,
      optionId: data.optionId,
      groupLabel: data.groupLabel,
    },
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
export async function moveSectionOrder(sectionId: string, direction: "up" | "down") {
  const section = await db.estimateSection.findUniqueOrThrow({ where: { id: sectionId } });
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
  data: { name: string; sectionType: SectionType; sortOrder?: number; groupLabel?: string | null },
) {
  const existing = await db.estimateSection.findFirst({
    where: { estimateVersionId, optionId: null, name: data.name, groupLabel: data.groupLabel ?? null },
  });
  if (existing) return existing;
  return addSection(estimateVersionId, data);
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

export async function addLineItem(
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
    qty: DecimalInput;
    unit?: string | null;
    unitCost: DecimalInput;
    // Phase 4 design-intake prototype: a draft line item references the
    // Attachment (design pull sheet) it was drafted from and is excluded
    // from cost rollups until confirmDraftLineItem below.
    isDraft?: boolean;
    attachmentId?: string | null;
  },
) {
  const section = await db.estimateSection.findUniqueOrThrow({ where: { id: sectionId } });
  await assertUnlocked(section.estimateVersionId);

  return db.lineItem.create({
    data: {
      sectionId,
      lineType: data.lineType,
      description: data.description,
      department: data.department ?? null,
      category: data.category ?? null,
      isClientOwned: data.isClientOwned ?? false,
      qty: new Prisma.Decimal(data.qty),
      unit: data.unit ?? null,
      unitCost: new Prisma.Decimal(data.unitCost),
      totalCost: computeLineItemTotal(data.qty, data.unitCost),
      isDraft: data.isDraft ?? false,
      attachmentId: data.attachmentId ?? null,
    },
  });
}

// Phase 7.1: bulk insert for document-sourced imports (a real pricing
// schedule runs ~185 rows -- see data/RFP/superbowl). One $transaction +
// one recomputeVersionTotals call at the end, rather than looping
// addLineItem's single-row create + implicit per-row totals recompute
// callers do today (see addLineItemAction). Every row is unconditionally
// isDraft: true -- this path never exposes a way to skip human review.
export async function addLineItemsBulk(
  estimateVersionId: string,
  sectionId: string,
  items: {
    lineType: LineItemType;
    description: string;
    department?: string | null;
    category?: string | null;
    isClientOwned?: boolean;
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
  }[],
) {
  await assertUnlocked(estimateVersionId);
  if (items.length === 0) return [];

  await db.$transaction(
    items.map((item) =>
      db.lineItem.create({
        data: {
          sectionId,
          lineType: item.lineType,
          description: item.description,
          department: item.department ?? null,
          category: item.category ?? null,
          isClientOwned: item.isClientOwned ?? false,
          qty: new Prisma.Decimal(item.qty),
          unit: item.unit ?? null,
          unitCost: new Prisma.Decimal(item.unitCost),
          totalCost: computeLineItemTotal(item.qty, item.unitCost),
          isDraft: true,
          documentId: item.documentId,
          sourceQuote: item.sourceQuote ?? null,
          sourcePageNumber: item.sourcePageNumber ?? null,
        },
      }),
    ),
  );

  await recomputeVersionTotals(estimateVersionId);
  return db.lineItem.findMany({ where: { sectionId, documentId: items[0].documentId } });
}

export async function updateLineItem(
  lineItemId: string,
  data: {
    description?: string;
    lineType?: LineItemType;
    department?: string | null;
    category?: string | null;
    isClientOwned?: boolean;
    qty?: DecimalInput;
    unit?: string | null;
    unitCost?: DecimalInput;
  },
) {
  const existing = await db.lineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);

  const qty = data.qty ?? existing.qty;
  const unitCost = data.unitCost ?? existing.unitCost;

  return db.lineItem.update({
    where: { id: lineItemId },
    data: {
      description: data.description ?? existing.description,
      lineType: data.lineType ?? existing.lineType,
      department: data.department !== undefined ? data.department : existing.department,
      category: data.category !== undefined ? data.category : existing.category,
      isClientOwned: data.isClientOwned ?? existing.isClientOwned,
      qty: new Prisma.Decimal(qty),
      unit: data.unit !== undefined ? data.unit : existing.unit,
      unitCost: new Prisma.Decimal(unitCost),
      totalCost: computeLineItemTotal(qty, unitCost),
    },
  });
}

// Same swap-with-neighbor-then-renumber-all approach as moveSectionOrder,
// scoped to line items sharing this item's sectionId (production-tracking
// order within a COMPONENT/CATEGORY-type section) -- unrelated to
// `category`, the client-facing proposal grouping, which this never
// touches.
export async function moveLineItemWithinSection(lineItemId: string, direction: "up" | "down") {
  const item = await db.lineItem.findUniqueOrThrow({ where: { id: lineItemId }, include: { section: true } });
  await assertUnlocked(item.section.estimateVersionId);

  const siblings = await db.lineItem.findMany({
    where: { sectionId: item.sectionId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  const index = siblings.findIndex((s) => s.id === lineItemId);
  const swapWith = direction === "up" ? index - 1 : index + 1;
  if (swapWith < 0 || swapWith >= siblings.length) return;

  const reordered = [...siblings];
  [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

  await db.$transaction(
    reordered.map((li, i) => db.lineItem.update({ where: { id: li.id }, data: { sortOrder: i } })),
  );
}

// The missing primitive for the line-item-audit-service.ts "move to the
// correct project" fix -- moveLineItemWithinSection only reorders inside
// one section, and nothing else in this file changes a LineItem's
// sectionId. Reuses findOrCreateSection so a target estimate that already
// has a same-named section (the common case -- both estimates' documents
// were classified against the same fixed SCOPE_CATEGORIES list) gets the
// item merged in rather than a duplicate section created. Both versions'
// totals change, so both get recomputed, not just the destination.
export async function moveLineItemToEstimate(lineItemId: string, targetEstimateId: string) {
  const lineItem = await db.lineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    include: { section: true },
  });
  const fromEstimateVersionId = lineItem.section.estimateVersionId;
  await assertUnlocked(fromEstimateVersionId);

  const targetVersion = await db.estimateVersion.findFirstOrThrow({
    where: { estimateId: targetEstimateId, isCurrent: true },
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

export async function archiveEstimate(id: string) {
  return db.estimate.update({ where: { id }, data: { deletedAt: new Date() } });
}

export async function deleteLineItem(lineItemId: string) {
  const existing = await db.lineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);
  const deleted = await db.lineItem.delete({ where: { id: lineItemId } });
  return { ...deleted, estimateVersionId: existing.section.estimateVersionId };
}

// Marks a draft line item (Phase 4 design-intake prototype) as
// human-reviewed and priced -- migration-plan.md's "human-reviewed
// before pricing" -- so it starts counting toward the version's totals.
export async function confirmDraftLineItem(lineItemId: string) {
  const existing = await db.lineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);
  await db.lineItem.update({ where: { id: lineItemId }, data: { isDraft: false } });
  await recomputeVersionTotals(existing.section.estimateVersionId);
  return db.lineItem.findUniqueOrThrow({ where: { id: lineItemId } });
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

// Recomputes and persists totalCost/grandTotal/grossMarginPct without
// locking -- lets the UI show a live-updating grand total as line items
// change, per task #38's "live-computed totals."
export async function recomputeVersionTotals(estimateVersionId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: VERSION_WITH_TOTALS_INCLUDE,
  });

  const totals = computeVersionTotals(version);

  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: totals,
  });
}

// Immutable once locked (schema.prisma's EstimateVersion comment) --
// freezes totals and flips isLocked so addSection/addLineItem/etc. above
// start rejecting further edits.
export async function lockEstimateVersion(estimateVersionId: string) {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: VERSION_WITH_TOTALS_INCLUDE,
  });
  if (version.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is already locked.`);
  }

  const totals = computeVersionTotals(version);

  return db.estimateVersion.update({
    where: { id: estimateVersionId },
    data: { ...totals, isLocked: true, lockedAt: new Date() },
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
    },
  });
  if (!source.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is not locked; only locked versions can be copied.`);
  }

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

    return created;
  });
}
