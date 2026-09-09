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
    lostReasonGroups,
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
    // LOST specifically, not WON+LOST together -- this is the
    // actionable half (why are we losing deals), and closeReason is
    // null for every pre-migration LOST opportunity, so counts here
    // only reflect deals closed after this feature shipped.
    db.opportunity.groupBy({
      by: ["closeReason"],
      where: { deletedAt: null, stage: "LOST", closeReason: { not: null } },
      _count: { _all: true },
    }),
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

  const lostReasonCounts = Object.fromEntries(
    lostReasonGroups.map((g) => [g.closeReason, g._count._all]),
  ) as Record<string, number>;

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
      lostReasonCounts,
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

// SUPER_ADMIN-only (see src/app/(app)/page.tsx's own gating) -- a real
// error message, not just the "Analysis failed" chip every user already
// sees. Kept separate from getAdminAnalytics above (which both ADMIN and
// SUPER_ADMIN see) rather than folded into it, since this is the one
// piece of the dashboard the plain ADMIN role deliberately doesn't get:
// see Document.analysisError's own schema comment for the incident that
// motivated this (a failure that left zero trace anywhere until logging
// was added at the source).
export async function getRecentAnalysisFailures(limit = 10) {
  return db.document.findMany({
    where: { extractionStatus: "FAILED" },
    // nulls: "last" -- a FAILED document from before analysisErrorAt
    // existed has no timestamp at all; Postgres's DESC default (NULLS
    // FIRST) would otherwise push those undated old failures ahead of
    // genuinely recent ones.
    orderBy: { analysisErrorAt: { sort: "desc", nulls: "last" } },
    take: limit,
    select: {
      id: true,
      filename: true,
      analysisError: true,
      analysisErrorAt: true,
      opportunityId: true,
      opportunity: { select: { showName: true, company: { select: { name: true } } } },
    },
  });
}
