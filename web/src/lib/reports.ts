// B8: reporting/analytics data for the /reports page. Reuses the same
// stage-order and win/loss vocabulary as admin-analytics.ts and the
// Opportunities board, but this file answers three different questions:
// how far leads actually get (cohort funnel, not a snapshot of today's
// stage counts), which shows convert best, and whether margins are
// drifting over time.

import type { SystemRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { opportunityAccessWhere } from "@/lib/opportunity-access";

const FUNNEL_STAGES = ["NEW", "CONTACTED", "QUALIFIED", "ESTIMATING", "WON"] as const;

export async function getReportsData(user: { id: string; systemRole: SystemRole }) {
  const accessWhere = opportunityAccessWhere(user);

  const [stageEvents, closedOpportunities, currentVersions] = await Promise.all([
    // Every opportunity logs a toStage=NEW event at creation (see
    // opportunity-service.ts), so "reached NEW" is the same as "ever
    // created" -- this is a cohort funnel, not today's stage snapshot.
    db.stageChangeEvent.findMany({
      where: { toStage: { in: [...FUNNEL_STAGES] }, opportunity: accessWhere },
      select: { opportunityId: true, toStage: true },
    }),
    db.opportunity.findMany({
      where: { deletedAt: null, stage: { in: ["WON", "LOST"] }, ...accessWhere },
      select: { showName: true, stage: true },
    }),
    db.estimateVersion.findMany({
      where: { isCurrent: true, estimate: { opportunity: accessWhere } },
      select: { createdAt: true, grossMarginPct: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const reachedByStage = new Map<string, Set<string>>();
  for (const stage of FUNNEL_STAGES) reachedByStage.set(stage, new Set());
  for (const event of stageEvents) {
    reachedByStage.get(event.toStage)?.add(event.opportunityId);
  }

  const funnel = FUNNEL_STAGES.map((stage, i) => {
    const reached = reachedByStage.get(stage)?.size ?? 0;
    const prevReached = i > 0 ? (reachedByStage.get(FUNNEL_STAGES[i - 1])?.size ?? 0) : reached;
    return {
      stage,
      reached,
      conversionFromPrevPct: i === 0 || prevReached === 0 ? null : (reached / prevReached) * 100,
      conversionFromStartPct: reached === 0 ? 0 : (reached / ((reachedByStage.get(FUNNEL_STAGES[0])?.size ?? 1) || 1)) * 100,
    };
  });

  const showTotals = new Map<string, { won: number; lost: number }>();
  for (const opp of closedOpportunities) {
    const entry = showTotals.get(opp.showName) ?? { won: 0, lost: 0 };
    if (opp.stage === "WON") entry.won += 1;
    else entry.lost += 1;
    showTotals.set(opp.showName, entry);
  }
  const winRateByShow = [...showTotals.entries()]
    .map(([showName, { won, lost }]) => ({
      showName,
      won,
      lost,
      total: won + lost,
      winRatePct: (won / (won + lost)) * 100,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const marginByMonth = new Map<string, { sum: number; count: number }>();
  for (const version of currentVersions) {
    const key = version.createdAt.toISOString().slice(0, 7); // YYYY-MM
    const entry = marginByMonth.get(key) ?? { sum: 0, count: 0 };
    entry.sum += version.grossMarginPct.toNumber();
    entry.count += 1;
    marginByMonth.set(key, entry);
  }
  const marginTrend = [...marginByMonth.entries()]
    .map(([month, { sum, count }]) => ({ month, avgMarginPct: sum / count, count }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return { funnel, winRateByShow, marginTrend };
}
