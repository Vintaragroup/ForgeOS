// First-cut analytics for the admin dashboard (backlog B8). Reuses
// cost-actual-service.ts's variance math rather than re-deriving it --
// same "reuse, don't duplicate" pattern Phase 4 used for ChangeOrder/Option.

import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { computeLineItemVariance } from "@/lib/cost-actual-service";
import { getOrgAiUsageSummary } from "@/lib/ai/ai-usage-service";

export async function getAdminAnalytics() {
  const [
    stageGroups,
    versionsCurrent,
    versionsLocked,
    versionsApproved,
    proposalsTotal,
    proposalsSent,
    proposalsSigned,
    roleGroups,
    lineItemsWithActuals,
    aiUsage,
  ] = await Promise.all([
    db.opportunity.groupBy({ by: ["stage"], where: { deletedAt: null }, _count: { _all: true } }),
    db.estimateVersion.count({ where: { isCurrent: true } }),
    db.estimateVersion.count({ where: { isCurrent: true, isLocked: true } }),
    db.estimateVersion.count({ where: { isCurrent: true, isApproved: true } }),
    db.proposal.count({ where: { deletedAt: null } }),
    db.proposal.count({ where: { deletedAt: null, sentAt: { not: null } } }),
    db.proposal.count({ where: { deletedAt: null, signedAt: { not: null } } }),
    db.user.groupBy({ by: ["systemRole"], where: { deletedAt: null }, _count: { _all: true } }),
    db.lineItem.findMany({
      where: { costActuals: { some: {} } },
      select: {
        id: true,
        description: true,
        department: true,
        totalCost: true,
        costActuals: { select: { actualCost: true } },
      },
    }),
    getOrgAiUsageSummary(),
  ]);

  const stageCounts = Object.fromEntries(
    stageGroups.map((g) => [g.stage, g._count._all]),
  ) as Record<string, number>;
  const won = stageCounts.WON ?? 0;
  const lost = stageCounts.LOST ?? 0;
  const closed = won + lost;

  const roleCounts = Object.fromEntries(
    roleGroups.map((g) => [g.systemRole, g._count._all]),
  ) as Record<string, number>;

  const variances = computeLineItemVariance(lineItemsWithActuals);
  const estimatedTotal = variances.reduce((sum, v) => sum.plus(v.estimatedCost), new Prisma.Decimal(0));
  const actualTotal = variances.reduce((sum, v) => sum.plus(v.actualCost), new Prisma.Decimal(0));

  return {
    pipeline: {
      byStage: stageCounts,
      winRatePct: closed > 0 ? (won / closed) * 100 : null,
      closedCount: closed,
    },
    estimates: {
      current: versionsCurrent,
      locked: versionsLocked,
      approved: versionsApproved,
    },
    proposals: {
      total: proposalsTotal,
      sent: proposalsSent,
      signed: proposalsSigned,
      signRatePct: proposalsSent > 0 ? (proposalsSigned / proposalsSent) * 100 : null,
    },
    costVariance: {
      lineItemCount: variances.length,
      estimatedTotal: estimatedTotal.toNumber(),
      actualTotal: actualTotal.toNumber(),
      variance: actualTotal.minus(estimatedTotal).toNumber(),
    },
    users: {
      total: (roleCounts.SUPER_ADMIN ?? 0) + (roleCounts.ADMIN ?? 0) + (roleCounts.EMPLOYEE ?? 0),
      byRole: roleCounts,
    },
    aiUsage: {
      calls: aiUsage.totals._count._all,
      tokens: aiUsage.totals._sum.totalTokens ?? 0,
      estimatedCostUsd: aiUsage.totals._sum.estimatedCostUsd?.toNumber() ?? 0,
      drawingAnalyses: aiUsage.byFeature.find((f) => f.feature === "DRAWING_SUMMARY")?._count._all ?? 0,
    },
  };
}
