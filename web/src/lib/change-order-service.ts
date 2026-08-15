// ChangeOrder authoring (docs/migration-plan.md Phase 4) -- a post-
// approval modification to an estimate, stored as a diff against the
// approved EstimateVersion rather than the workbook's from-scratch
// "short form estimate" pattern (data-model-v0.md's ChangeOrder entity,
// schema.prisma's comment). Deliberately reuses estimate-service.ts's
// existing version/section/line-item machinery instead of a parallel
// delta-storage model: a ChangeOrder's resultVersion is a normal
// EstimateVersion, editable with the same addSection/addLineItem/
// lockEstimateVersion functions already built for Phase 3.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { createNewVersionFromLocked } from "@/lib/estimate-service";

async function assertBaseIsLockedAndApproved(baseVersionId: string) {
  const base = await db.estimateVersion.findUniqueOrThrow({ where: { id: baseVersionId } });
  if (!base.isLocked || !base.isApproved) {
    throw new Error(
      `EstimateVersion ${baseVersionId} must be locked and approved before a ChangeOrder can be opened against it.`,
    );
  }
  return base;
}

// Opens a ChangeOrder: duplicates baseVersion into a fresh, unlocked
// resultVersion (via the same copy logic "Create new version" already
// uses) that becomes the estimate's current editable version. The
// estimator edits resultVersion with the normal estimate UI, then locks
// it and calls approveChangeOrder below.
export async function createChangeOrder(estimateId: string, baseVersionId: string, description: string) {
  const base = await assertBaseIsLockedAndApproved(baseVersionId);
  if (base.estimateId !== estimateId) {
    throw new Error(`EstimateVersion ${baseVersionId} does not belong to Estimate ${estimateId}.`);
  }

  const resultVersion = await createNewVersionFromLocked(baseVersionId);

  return db.changeOrder.create({
    data: {
      estimateId,
      baseVersionId,
      resultVersionId: resultVersion.id,
      description,
    },
  });
}

// estimateId is the caller's already-access-checked estimate (from
// requireEstimateAccess), NOT trusted from changeOrderId alone -- see
// estimate-service.ts's deleteLineItem for the full rationale.
async function assertChangeOrderBelongsToEstimate(estimateId: string, changeOrderId: string) {
  const changeOrder = await db.changeOrder.findFirstOrThrow({
    where: { id: changeOrderId, estimateId },
    include: { resultVersion: true },
  });
  return changeOrder;
}

export async function approveChangeOrder(estimateId: string, changeOrderId: string) {
  const changeOrder = await assertChangeOrderBelongsToEstimate(estimateId, changeOrderId);
  if (!changeOrder.resultVersion.isLocked) {
    throw new Error(`ChangeOrder ${changeOrderId}'s result version must be locked before it can be approved.`);
  }
  return db.changeOrder.update({
    where: { id: changeOrderId },
    data: { status: "APPROVED", approvedAt: new Date() },
  });
}

export async function rejectChangeOrder(estimateId: string, changeOrderId: string) {
  await assertChangeOrderBelongsToEstimate(estimateId, changeOrderId);
  return db.changeOrder.update({
    where: { id: changeOrderId },
    data: { status: "REJECTED" },
  });
}

export interface ChangeOrderDiffRow {
  section: string;
  description: string;
  kind: "ADDED" | "REMOVED" | "CHANGED";
  baseTotalCost: Prisma.Decimal | null;
  resultTotalCost: Prisma.Decimal | null;
  delta: Prisma.Decimal;
}

interface DiffableSection {
  name: string;
  lineItems: { description: string; totalCost: Prisma.Decimal | number | string }[];
}

// Line items don't share IDs across the base/result copy (each version's
// rows are independently created), so rows are matched by
// (section name, description) instead. Unchanged rows are omitted --
// this is a change list, not a full reprint of both estimates.
export function computeChangeOrderDiff(base: DiffableSection[], result: DiffableSection[]): ChangeOrderDiffRow[] {
  const flatten = (sections: DiffableSection[]) => {
    const map = new Map<string, { section: string; description: string; totalCost: Prisma.Decimal }>();
    for (const section of sections) {
      for (const li of section.lineItems) {
        map.set(`${section.name}::${li.description}`, {
          section: section.name,
          description: li.description,
          totalCost: new Prisma.Decimal(li.totalCost),
        });
      }
    }
    return map;
  };

  const baseMap = flatten(base);
  const resultMap = flatten(result);
  const rows: ChangeOrderDiffRow[] = [];

  for (const [key, resultRow] of resultMap) {
    const baseRow = baseMap.get(key);
    if (!baseRow) {
      rows.push({
        section: resultRow.section,
        description: resultRow.description,
        kind: "ADDED",
        baseTotalCost: null,
        resultTotalCost: resultRow.totalCost,
        delta: resultRow.totalCost,
      });
    } else if (!baseRow.totalCost.equals(resultRow.totalCost)) {
      rows.push({
        section: resultRow.section,
        description: resultRow.description,
        kind: "CHANGED",
        baseTotalCost: baseRow.totalCost,
        resultTotalCost: resultRow.totalCost,
        delta: resultRow.totalCost.minus(baseRow.totalCost),
      });
    }
  }

  for (const [key, baseRow] of baseMap) {
    if (!resultMap.has(key)) {
      rows.push({
        section: baseRow.section,
        description: baseRow.description,
        kind: "REMOVED",
        baseTotalCost: baseRow.totalCost,
        resultTotalCost: null,
        delta: baseRow.totalCost.negated(),
      });
    }
  }

  return rows;
}
