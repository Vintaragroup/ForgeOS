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

export function computeSectionTotal(lineItems: { totalCost: DecimalInput }[]): Decimal {
  return lineItems.reduce(
    (sum, li) => sum.plus(li.totalCost),
    new Prisma.Decimal(0),
  );
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

const VERSION_WITH_TOTALS_INCLUDE = {
  sections: { include: { lineItems: true } },
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
  data: { name: string; sectionType: SectionType; sortOrder?: number },
) {
  await assertUnlocked(estimateVersionId);
  return db.estimateSection.create({
    data: {
      estimateVersionId,
      name: data.name,
      sectionType: data.sectionType,
      sortOrder: data.sortOrder ?? 0,
    },
  });
}

export async function addLineItem(
  sectionId: string,
  data: {
    lineType: LineItemType;
    description: string;
    department?: string | null;
    qty: DecimalInput;
    unitCost: DecimalInput;
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
    },
  });
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

export async function deleteLineItem(lineItemId: string) {
  const existing = await db.lineItem.findUniqueOrThrow({
    where: { id: lineItemId },
    include: { section: true },
  });
  await assertUnlocked(existing.section.estimateVersionId);
  const deleted = await db.lineItem.delete({ where: { id: lineItemId } });
  return { ...deleted, estimateVersionId: existing.section.estimateVersionId };
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

// Duplicates a locked version's sections/line items into a fresh unlocked
// version rather than mutating history -- the "Create new version" flow
// schema.prisma's EstimateVersion comment describes.
export async function createNewVersionFromLocked(estimateVersionId: string) {
  const source = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    include: VERSION_WITH_TOTALS_INCLUDE,
  });
  if (!source.isLocked) {
    throw new Error(`EstimateVersion ${estimateVersionId} is not locked; only locked versions can be copied.`);
  }

  const [, created] = await db.$transaction([
    db.estimateVersion.update({ where: { id: source.id }, data: { isCurrent: false } }),
    db.estimateVersion.create({
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
            lineItems: {
              create: section.lineItems.map((li) => ({
                lineType: li.lineType,
                description: li.description,
                department: li.department,
                qty: li.qty,
                unitCost: li.unitCost,
                totalCost: li.totalCost,
              })),
            },
          })),
        },
      },
    }),
  ]);

  return created;
}
