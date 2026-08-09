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

async function assertUnlocked(estimateVersionId: string) {
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
  data: { name: string; sectionType: SectionType; sortOrder?: number; optionId?: string },
) {
  await assertUnlocked(estimateVersionId);
  return db.estimateSection.create({
    data: {
      estimateVersionId,
      name: data.name,
      sectionType: data.sectionType,
      sortOrder: data.sortOrder ?? 0,
      optionId: data.optionId,
    },
  });
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
    qty: DecimalInput;
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
      qty: new Prisma.Decimal(data.qty),
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
    qty: DecimalInput;
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
          qty: new Prisma.Decimal(item.qty),
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
  data: { description?: string; department?: string | null; qty?: DecimalInput; unitCost?: DecimalInput },
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
      department: data.department !== undefined ? data.department : existing.department,
      qty: new Prisma.Decimal(qty),
      unitCost: new Prisma.Decimal(unitCost),
      totalCost: computeLineItemTotal(qty, unitCost),
    },
  });
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
