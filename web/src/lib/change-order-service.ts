// ChangeOrder authoring (docs/migration-plan.md Phase 4) -- a change to
// work a client has already SIGNED FOR, stored as a diff against the
// signed EstimateVersion rather than the workbook's from-scratch "short
// form estimate" pattern (data-model-v0.md's ChangeOrder entity,
// schema.prisma's comment). Deliberately reuses estimate-service.ts's
// existing version/section/line-item machinery instead of a parallel
// delta-storage model: a ChangeOrder's resultVersion is a normal
// EstimateVersion, editable with the same addSection/addLineItem/
// lockEstimateVersion functions already built for Phase 3.
//
// A change order is a PRODUCTION term and it means something specific:
// the client signed, and is now adding scope beyond what they signed
// for. It is not what happens when a client reads a proposal and asks
// for a different number -- nothing has been ordered yet, so there is no
// order to change. That is an Estimate Change Request, and it lives in
// proposal-service.ts (requestProposalRevisions).
//
// This file used to gate on "locked and approved", which is INTERNAL
// approval -- an Expo estimator signing off on their own number. It
// would open a change order against an estimate no client had ever seen,
// let alone signed. The gate is a signed proposal now, so the term can
// only ever be recorded against something the word actually fits.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { createNewVersionFromLocked } from "@/lib/estimate-service";
import { UserError } from "@/lib/user-error";

async function assertBaseIsSigned(baseVersionId: string) {
  const base = await db.estimateVersion.findUniqueOrThrow({
    where: { id: baseVersionId },
    include: { proposals: { where: { signedAt: { not: null }, deletedAt: null }, take: 1 } },
  });
  if (!base.isLocked || !base.isApproved) {
    throw new UserError("This version has to be locked and approved before anything can be changed against it.");
  }
  // The distinction the word depends on. Without a signature there is no
  // order, so there is nothing to change -- what the client is asking for
  // is an Estimate Change Request, which revises the estimate instead.
  if (base.proposals.length === 0) {
    throw new UserError(
      "Nobody has signed this estimate, so there's no order to change. Use Request an estimate change instead -- " +
        "a change order is for scope a client adds after they've signed.",
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
  const base = await assertBaseIsSigned(baseVersionId);
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
