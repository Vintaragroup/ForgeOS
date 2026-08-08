// The landing-page dashboard (backlog B5) -- operational "what needs
// attention" for any logged-in user, distinct from admin-analytics.ts's
// richer BI-style metrics (which stay admin-only).

import { db } from "@/lib/db";

const DEADLINE_WINDOW_DAYS = 30;
const UPCOMING_LIMIT = 8;
const RECENT_PROPOSALS_LIMIT = 5;

type DeadlineKind = "Deposit due" | "Production meeting" | "Artwork deadline" | "Balance due" | "Install";

export interface UpcomingDeadline {
  workOrderId: string;
  projectId: string;
  label: string;
  kind: DeadlineKind;
  date: Date;
  overdue: boolean;
}

export async function getDashboardData() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + DEADLINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [stageGroups, workOrders, recentProposals] = await Promise.all([
    db.opportunity.groupBy({ by: ["stage"], where: { deletedAt: null }, _count: { _all: true } }),
    db.workOrder.findMany({
      where: {
        deletedAt: null,
        project: { deletedAt: null, status: "ACTIVE" },
        OR: [
          { depositDueDate: { lte: windowEnd } },
          { productionMeetingDate: { lte: windowEnd } },
          { artworkDeadlineDate: { lte: windowEnd } },
          { balanceDueDate: { lte: windowEnd } },
          { installDate: { lte: windowEnd } },
        ],
      },
      include: { project: { include: { opportunity: true } } },
    }),
    db.proposal.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: RECENT_PROPOSALS_LIMIT,
      include: {
        estimateVersion: { include: { estimate: { include: { opportunity: { include: { company: true } } } } } },
      },
    }),
  ]);

  const stageCounts = Object.fromEntries(
    stageGroups.map((g) => [g.stage, g._count._all]),
  ) as Record<string, number>;

  const deadlineFields: { field: keyof typeof workOrders[number]; kind: DeadlineKind }[] = [
    { field: "depositDueDate", kind: "Deposit due" },
    { field: "productionMeetingDate", kind: "Production meeting" },
    { field: "artworkDeadlineDate", kind: "Artwork deadline" },
    { field: "balanceDueDate", kind: "Balance due" },
    { field: "installDate", kind: "Install" },
  ];

  const upcoming: UpcomingDeadline[] = [];
  for (const wo of workOrders) {
    for (const { field, kind } of deadlineFields) {
      const date = wo[field] as Date | null;
      if (!date || date > windowEnd) continue;
      upcoming.push({
        workOrderId: wo.id,
        projectId: wo.projectId,
        label: wo.project.jobNumber ? `Job ${wo.project.jobNumber}` : wo.project.opportunity.showName,
        kind,
        date,
        overdue: date < now,
      });
    }
  }
  upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());

  return {
    pipeline: { byStage: stageCounts },
    upcomingDeadlines: upcoming.slice(0, UPCOMING_LIMIT),
    recentProposals,
  };
}
