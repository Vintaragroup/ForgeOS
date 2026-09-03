// The landing-page dashboard (backlog B5) -- operational "what needs
// attention" for any logged-in user, distinct from admin-analytics.ts's
// richer BI-style metrics (which stay admin-only).

import type { SystemRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { citationHref, parseFreeTextDate } from "@/lib/citation";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { slugifyGroupLabel } from "@/lib/excluded-from-totals-audit";

const DEADLINE_WINDOW_DAYS = 30;
// Symmetric with the forward window -- without a lower bound, a deadline
// that's overdue by any amount, even years, would show up here forever.
// "Upcoming deadlines (next 30 days)" implies a recent-past grace window
// too (something 3 days overdue still needs attention), not an
// unbounded backlog.
const PAST_DEADLINE_GRACE_DAYS = 30;
const UPCOMING_LIMIT = 8;
const RECENT_PROPOSALS_LIMIT = 5;
const FLAGGED_FOR_REVIEW_LIMIT = 8;

type DeadlineKind =
  | "Deposit due"
  | "Production meeting"
  | "Artwork deadline"
  | "Balance due"
  | "Install"
  | "RFP deadline"
  | "RFP milestone";

export type DeadlineActionStatus = "SCHEDULED" | "SUBMITTED" | "PAID";

// Lightweight per-kind action, not a real reminders engine -- see
// DeadlineAction's own schema comment. Kinds not listed here (Install,
// which is usually auto-filled off the WorkOrder's own dates) get no
// action button at all.
const DEADLINE_ACTIONS: Partial<Record<DeadlineKind, { label: string; status: DeadlineActionStatus }>> = {
  "Production meeting": { label: "Schedule", status: "SCHEDULED" },
  "RFP milestone": { label: "Schedule", status: "SCHEDULED" },
  "RFP deadline": { label: "Mark submitted", status: "SUBMITTED" },
  "Artwork deadline": { label: "Mark submitted", status: "SUBMITTED" },
  "Deposit due": { label: "Mark paid", status: "PAID" },
  "Balance due": { label: "Mark paid", status: "PAID" },
};

export interface UpcomingDeadline {
  key: string;
  // Scoped to this deadline within its own opportunity -- matches
  // DeadlineAction.dedupeKey, which is unique per [opportunityId, dedupeKey]
  // rather than globally, so it doesn't need opportunityId baked in. `key`
  // above is the globally-unique one (React list key / persisted-action
  // identity together with opportunityId).
  dedupeKey: string;
  href: string;
  label: string;
  kind: DeadlineKind;
  date: Date;
  overdue: boolean;
  opportunityId: string;
  opportunityName: string;
  action: { label: string; status: DeadlineActionStatus } | null;
}

// One row per booth/section flagged EstimateSection.excludedFromTotals
// (see that field's own schema comment) across every opportunity this
// user can see -- "tell me when this happens in future opportunities
// created by users," not something you'd only discover by opening the
// one estimate it happened on. Same grouping (one booth's sections
// collapsed into one row, summed) as excluded-from-totals-audit.ts's own
// auditExcludedFromTotals, but computed directly here rather than reusing
// that function -- this only ever needs the aggregate cost/count across
// every accessible opportunity, not the per-line-item citation detail
// that function's Review-tab card needs (which would mean loading every
// flagged line item's full row, org-wide, for a Dashboard card that only
// ever shows a count and a link).
export interface FlaggedForReviewItem {
  key: string;
  estimateId: string;
  opportunityName: string;
  groupLabel: string;
  cost: number;
  href: string;
}

export async function getDashboardData(user: { id: string; systemRole: SystemRole }) {
  const accessWhere = opportunityAccessWhere(user);

  const now = new Date();
  const windowEnd = new Date(now.getTime() + DEADLINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const windowStart = new Date(now.getTime() - PAST_DEADLINE_GRACE_DAYS * 24 * 60 * 60 * 1000);

  const [stageGroups, workOrders, rfpDocuments, recentProposals, deadlineActions, excludedSections] = await Promise.all([
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
    // Deadlines the user has already scheduled/submitted/paid drop off the
    // list entirely -- see DeadlineAction's schema comment.
    db.deadlineAction.findMany({
      where: { opportunity: accessWhere },
      select: { opportunityId: true, dedupeKey: true },
    }),
    // isCurrent -- an older, superseded version's own flagged items are
    // no longer what anyone would act on; only the version someone could
    // actually still edit matters here.
    db.estimateSection.findMany({
      where: {
        excludedFromTotals: true,
        groupLabel: { not: null },
        estimateVersion: { isCurrent: true, estimate: { opportunity: accessWhere } },
      },
      select: {
        groupLabel: true,
        estimateVersionId: true,
        lineItems: { where: { isDraft: false }, select: { totalCost: true } },
        estimateVersion: { select: { estimate: { select: { id: true, opportunity: { select: { showName: true } } } } } },
      },
    }),
  ]);

  const actedKeys = new Set(deadlineActions.map((a) => `${a.opportunityId}::${a.dedupeKey}`));

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
      const opportunityId = wo.project.opportunityId;
      const dedupeKey = `wo-${wo.id}-${kind}`;
      if (actedKeys.has(`${opportunityId}::${dedupeKey}`)) continue;
      upcoming.push({
        key: dedupeKey,
        dedupeKey,
        href: `/projects/${wo.projectId}`,
        // The opportunity name itself is now shown once as this deadline's
        // group header on the Dashboard -- see groupDeadlinesByOpportunity
        // -- so this only needs to add the job number, if any.
        label: wo.project.jobNumber ? `Job ${wo.project.jobNumber}` : "",
        kind,
        date,
        overdue: date < now,
        opportunityId,
        opportunityName: wo.project.opportunity.showName,
        action: DEADLINE_ACTIONS[kind] ?? null,
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

      // factKey (this opportunity's DeadlineAction.dedupeKey) is stable
      // across which document happens to restate the fact, unlike a
      // doc.id-based key. seenDedupeKey is scoped by opportunity too, so
      // two different opportunities that coincidentally share a label+date
      // don't get deduped against each other.
      const factKey = `${kd.label.trim().toLowerCase()}::${date.toISOString().slice(0, 10)}`;
      const seenDedupeKey = `${doc.opportunityId}::${factKey}`;
      if (seenKeyDates.has(seenDedupeKey)) continue;
      seenKeyDates.add(seenDedupeKey);
      if (actedKeys.has(seenDedupeKey)) continue;

      const href = citationHref(doc.opportunityId, doc, kd) ?? `/opportunities/${doc.opportunityId}`;
      const kind: DeadlineKind = dateType === "DEADLINE" ? "RFP deadline" : "RFP milestone";
      upcoming.push({
        key: seenDedupeKey,
        dedupeKey: factKey,
        href,
        label: kd.label,
        kind,
        date,
        overdue: dateType === "DEADLINE" && date < now,
        opportunityId: doc.opportunityId,
        opportunityName: doc.opportunity.showName,
        action: DEADLINE_ACTIONS[kind] ?? null,
      });
    }
  }

  upcoming.sort((a, b) => a.date.getTime() - b.date.getTime());

  // One row per (estimateVersion, groupLabel) -- a flagged booth's cost
  // can span several EstimateSection rows (Custom Build, Structure,
  // Labor, ...), same "collapse to one booth" convention as
  // excluded-from-totals-audit.ts's own auditExcludedFromTotals.
  const flaggedByKey = new Map<string, FlaggedForReviewItem>();
  for (const section of excludedSections) {
    const groupLabel = section.groupLabel!;
    const key = `${section.estimateVersionId}::${groupLabel}`;
    const cost = section.lineItems.reduce((sum, li) => sum + Number(li.totalCost), 0);
    const existing = flaggedByKey.get(key);
    if (existing) {
      existing.cost += cost;
      continue;
    }
    const estimateId = section.estimateVersion.estimate.id;
    flaggedByKey.set(key, {
      key,
      estimateId,
      opportunityName: section.estimateVersion.estimate.opportunity.showName,
      groupLabel,
      cost,
      href: `/estimates/${estimateId}?tab=review#excluded-${slugifyGroupLabel(groupLabel)}`,
    });
  }
  const flaggedForReview = [...flaggedByKey.values()].sort((a, b) => b.cost - a.cost);

  return {
    pipeline: { byStage: stageCounts },
    upcomingDeadlines: upcoming.slice(0, UPCOMING_LIMIT),
    recentProposals,
    flaggedForReview: flaggedForReview.slice(0, FLAGGED_FOR_REVIEW_LIMIT),
  };
}
