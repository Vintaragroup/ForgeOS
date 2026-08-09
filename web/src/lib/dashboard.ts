// The landing-page dashboard (backlog B5) -- operational "what needs
// attention" for any logged-in user, distinct from admin-analytics.ts's
// richer BI-style metrics (which stay admin-only).

import type { SystemRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { citationHref, parseFreeTextDate } from "@/lib/citation";
import { opportunityAccessWhere } from "@/lib/opportunity-access";

const DEADLINE_WINDOW_DAYS = 30;
// Symmetric with the forward window -- without a lower bound, a deadline
// that's overdue by any amount, even years, would show up here forever.
// "Upcoming deadlines (next 30 days)" implies a recent-past grace window
// too (something 3 days overdue still needs attention), not an
// unbounded backlog.
const PAST_DEADLINE_GRACE_DAYS = 30;
const UPCOMING_LIMIT = 8;
const RECENT_PROPOSALS_LIMIT = 5;

type DeadlineKind =
  | "Deposit due"
  | "Production meeting"
  | "Artwork deadline"
  | "Balance due"
  | "Install"
  | "RFP deadline"
  | "RFP milestone";

export interface UpcomingDeadline {
  key: string;
  href: string;
  label: string;
  kind: DeadlineKind;
  date: Date;
  overdue: boolean;
}

export async function getDashboardData(user: { id: string; systemRole: SystemRole }) {
  const accessWhere = opportunityAccessWhere(user);

  const now = new Date();
  const windowEnd = new Date(now.getTime() + DEADLINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const windowStart = new Date(now.getTime() - PAST_DEADLINE_GRACE_DAYS * 24 * 60 * 60 * 1000);

  const [stageGroups, workOrders, rfpDocuments, recentProposals] = await Promise.all([
    db.opportunity.groupBy({ by: ["stage"], where: { deletedAt: null, ...accessWhere }, _count: { _all: true } }),
    db.workOrder.findMany({
      where: {
        deletedAt: null,
        project: { deletedAt: null, status: "ACTIVE", opportunity: accessWhere },
        OR: [
          { depositDueDate: { lte: windowEnd, gte: windowStart } },
          { productionMeetingDate: { lte: windowEnd, gte: windowStart } },
          { artworkDeadlineDate: { lte: windowEnd, gte: windowStart } },
          { balanceDueDate: { lte: windowEnd, gte: windowStart } },
          { installDate: { lte: windowEnd, gte: windowStart } },
        ],
      },
      include: { project: { include: { opportunity: true } } },
    }),
    // Key dates the AI pulled out of an uploaded RFP/document -- an
    // extracted submission deadline is otherwise invisible unless
    // someone remembers to re-open the PDF it came from.
    db.document.findMany({
      where: { deletedAt: null, extractionStatus: "COMPLETE", opportunity: { deletedAt: null, ...accessWhere } },
      select: {
        id: true,
        mimeType: true,
        opportunityId: true,
        extractedSummary: true,
        opportunity: { select: { showName: true } },
      },
    }),
    db.proposal.findMany({
      where: { deletedAt: null, estimateVersion: { estimate: { opportunity: accessWhere } } },
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
      if (!date || date > windowEnd || date < windowStart) continue;
      upcoming.push({
        key: `wo-${wo.id}-${kind}`,
        href: `/projects/${wo.projectId}`,
        label: wo.project.jobNumber ? `Job ${wo.project.jobNumber}` : wo.project.opportunity.showName,
        kind,
        date,
        overdue: date < now,
      });
    }
  }

  // Two documents from the same RFP package routinely restate the same
  // fact -- the narrative RFP PDF and its own Appendix both say "Bidder
  // Questions Due," for instance. That's two independent citations for
  // one real deadline, not two deadlines; without deduping, every
  // multi-document opportunity shows each of its dates twice.
  const seenKeyDates = new Set<string>();
  for (const doc of rfpDocuments) {
    if (!doc.extractedSummary) continue;
    const summary = doc.extractedSummary as unknown as DocumentSummary;
    for (const kd of summary.keyDates) {
      // INFORMATIONAL dates are facts about something the CLIENT already
      // did ("RFP Sent", "Answers to Bidders' Questions Sent") -- not an
      // action item for us, so they don't belong in a deadlines list at
      // all. Older analyses predate this classification (dateType is
      // undefined on their stored JSON) -- default those to MILESTONE
      // rather than DEADLINE so a stale record can't falsely alarm as
      // "Overdue"; re-running Analyze on the document picks up the real
      // classification.
      const dateType = kd.dateType ?? "MILESTONE";
      if (dateType === "INFORMATIONAL") continue;

      const date = parseFreeTextDate(kd.date);
      if (!date || date > windowEnd || date < windowStart) continue;

      const dedupeKey = `${doc.opportunityId}::${kd.label.trim().toLowerCase()}::${date.toISOString().slice(0, 10)}`;
      if (seenKeyDates.has(dedupeKey)) continue;
      seenKeyDates.add(dedupeKey);

      const href = citationHref(doc.opportunityId, doc, kd) ?? `/opportunities/${doc.opportunityId}`;
      upcoming.push({
        key: `doc-${doc.id}-${kd.label}`,
        href,
        label: `${kd.label} — ${doc.opportunity.showName}`,
        kind: dateType === "DEADLINE" ? "RFP deadline" : "RFP milestone",
        date,
        overdue: dateType === "DEADLINE" && date < now,
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
