// True company profitability -- entirely separate from every sell-side
// margin figure in estimate-service.ts (computeVersionTotals's totalCost/
// grandTotal/grossMarginPct, EstimateSection/Category margin overrides).
// Those set the client's own price and can never move because of
// something the client will never see; this is the opposite: real
// dollars (business overhead, project-related costs the company
// absorbs, sales commission) that reduce what the company actually nets
// on a job. See InternalCost's own schema comment for the full picture.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { InternalCostCategory } from "@/generated/prisma/enums";

type Decimal = Prisma.Decimal;
type DecimalInput = Decimal | number | string;

export interface TrueProfitability {
  totalInternalCosts: Decimal;
  netProfit: Decimal;
  // Same zero-grandTotal guard as computeVersionTotals's own grossMarginPct
  // -- 0% here means "no sell price yet to divide by," not a real 0%
  // margin.
  netMarginPct: Decimal;
  anticipatedCommission: Decimal | null;
  contractedCommission: Decimal | null;
}

// Pure -- no db access, so the Profitability tab can compute this live off
// whatever's already loaded on the page, same as estimate-service.ts's own
// computeVersionTotals.
export function computeTrueProfitability(
  version: { totalCost: DecimalInput; grandTotal: DecimalInput },
  internalCosts: { amount: DecimalInput }[],
  fees: { anticipatedFeePct: DecimalInput | null; contractedFeePct: DecimalInput | null },
): TrueProfitability {
  const totalCost = new Prisma.Decimal(version.totalCost);
  const grandTotal = new Prisma.Decimal(version.grandTotal);
  const totalInternalCosts = internalCosts.reduce(
    (sum, c) => sum.plus(new Prisma.Decimal(c.amount)),
    new Prisma.Decimal(0),
  );
  const netProfit = grandTotal.minus(totalCost).minus(totalInternalCosts);
  const netMarginPct = grandTotal.isZero() ? new Prisma.Decimal(0) : netProfit.dividedBy(grandTotal).times(100);

  const anticipatedCommission =
    fees.anticipatedFeePct === null ? null : netProfit.times(new Prisma.Decimal(fees.anticipatedFeePct)).dividedBy(100);
  const contractedCommission =
    fees.contractedFeePct === null ? null : netProfit.times(new Prisma.Decimal(fees.contractedFeePct)).dividedBy(100);

  return { totalInternalCosts, netProfit, netMarginPct, anticipatedCommission, contractedCommission };
}

// Deliberately no assertUnlocked -- internal costs are never blocked by
// the client-facing lock (EstimateVersion.isLocked); an admin may need to
// true-up actual costs after a version is locked for the client. See
// InternalCost's own schema comment.
export async function addInternalCost(
  estimateVersionId: string,
  data: { sectionId: string | null; category: InternalCostCategory; description: string; amount: DecimalInput },
) {
  return db.internalCost.create({
    data: {
      estimateVersionId,
      sectionId: data.sectionId,
      category: data.category,
      description: data.description,
      amount: new Prisma.Decimal(data.amount),
    },
  });
}

export async function updateInternalCost(
  internalCostId: string,
  data: { category: InternalCostCategory; description: string; amount: DecimalInput },
) {
  return db.internalCost.update({
    where: { id: internalCostId },
    data: {
      category: data.category,
      description: data.description,
      amount: new Prisma.Decimal(data.amount),
    },
  });
}

export async function deleteInternalCost(internalCostId: string) {
  await db.internalCost.delete({ where: { id: internalCostId } });
}

export async function updateOpportunityProfitability(
  opportunityId: string,
  data: { salesRepId: string | null; anticipatedFeePct: DecimalInput | null; contractedFeePct: DecimalInput | null },
) {
  return db.opportunity.update({
    where: { id: opportunityId },
    data: {
      salesRepId: data.salesRepId,
      anticipatedFeePct: data.anticipatedFeePct === null ? null : new Prisma.Decimal(data.anticipatedFeePct),
      contractedFeePct: data.contractedFeePct === null ? null : new Prisma.Decimal(data.contractedFeePct),
    },
  });
}
