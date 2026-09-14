// Aggregates every date already scattered across the data model into one
// typed feed for the /calendar page and the Dashboard's CALENDAR widget:
// Opportunity's event/move/ship windows, WorkOrder's 5 milestone dates,
// Task due dates, ArtworkOrder's proof-check SLA, and freeform
// CalendarEvent rows. Deliberately its own service file (not folded into
// dashboard.ts), same reasoning as reports.ts: this spans many models and
// needs its own testable, page-independent module.
//
// No new access-control rule is invented here -- every source reuses
// opportunityAccessWhere (src/lib/opportunity-access.ts) or
// canAccessArtworkOrdersViaDepartment (src/lib/department-access.ts)
// exactly as their existing callers already do.

import type { Prisma, SystemRole } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { opportunityAccessWhere } from "@/lib/opportunity-access";
import { canAccessArtworkOrdersViaDepartment, type DepartmentUser } from "@/lib/department-access";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { citationHref, parseFreeTextDate } from "@/lib/citation";

export type CalendarItemType =
  | "OPPORTUNITY_EVENT_WINDOW"
  | "OPPORTUNITY_MOVE_WINDOW"
  | "OPPORTUNITY_SHIP_DATE"
  | "WORK_ORDER_DEPOSIT_DUE"
  | "WORK_ORDER_PRODUCTION_MEETING"
  | "WORK_ORDER_ARTWORK_DEADLINE"
  | "WORK_ORDER_BALANCE_DUE"
  | "WORK_ORDER_INSTALL"
  | "TASK_DUE"
  | "ARTWORK_SLA_DUE"
  | "RFP_DEADLINE"
  | "RFP_MILESTONE"
  | "CUSTOM";

export const CALENDAR_ITEM_TYPE_LABELS: Record<CalendarItemType, string> = {
  OPPORTUNITY_EVENT_WINDOW: "Show dates",
  OPPORTUNITY_MOVE_WINDOW: "Move-in / move-out",
  OPPORTUNITY_SHIP_DATE: "Ship date",
  WORK_ORDER_DEPOSIT_DUE: "Deposit due",
  WORK_ORDER_PRODUCTION_MEETING: "Production meeting",
  WORK_ORDER_ARTWORK_DEADLINE: "Artwork deadline",
  WORK_ORDER_BALANCE_DUE: "Balance due",
  WORK_ORDER_INSTALL: "Install",
  RFP_DEADLINE: "RFP deadline",
  RFP_MILESTONE: "RFP milestone",
  TASK_DUE: "Task due",
  ARTWORK_SLA_DUE: "Artwork proof SLA",
  CUSTOM: "Note",
};

// Reuses StatusChip's tone vocabulary (@/components/ui) for color
// consistency, even though the calendar page renders its own markup, not
// StatusChip itself.
export type CalendarItemTone = "neutral" | "info" | "warning" | "good" | "critical";

// WorkOrder's 5 milestone dates are also already surfaced by
// dashboard.ts's own UPCOMING DEADLINES section (same fields, its own
// DeadlineKind union) -- the Dashboard's CALENDAR widget excludes these
// item types so the two sections don't list the same deadline twice.
// /calendar itself keeps every type; this only trims what the Dashboard
// widget shows.
export const WORK_ORDER_ITEM_TYPES: readonly CalendarItemType[] = [
  "WORK_ORDER_DEPOSIT_DUE",
  "WORK_ORDER_PRODUCTION_MEETING",
  "WORK_ORDER_ARTWORK_DEADLINE",
  "WORK_ORDER_BALANCE_DUE",
  "WORK_ORDER_INSTALL",
];

// Same reasoning/purpose as WORK_ORDER_ITEM_TYPES above -- RFP key dates
// are also already surfaced by dashboard.ts's own UPCOMING DEADLINES
// section, so the Dashboard's CALENDAR widget excludes these item types
// too. /calendar itself keeps every type.
export const RFP_ITEM_TYPES: readonly CalendarItemType[] = ["RFP_DEADLINE", "RFP_MILESTONE"];

// One shared definition of "what the /calendar filter checkboxes mean" --
// the page (and anything else later) reads this rather than each
// hardcoding its own grouping, so "Shows" or "Production" can't drift out
// of sync between two places. calendar.test.ts asserts every
// CalendarItemType appears in exactly one group, so a newly added type
// can't silently fall through ungrouped.
export const CALENDAR_FILTER_GROUPS: Record<string, { label: string; types: CalendarItemType[] }> = {
  shows: { label: "Shows", types: ["OPPORTUNITY_EVENT_WINDOW", "OPPORTUNITY_MOVE_WINDOW", "OPPORTUNITY_SHIP_DATE"] },
  production: { label: "Production", types: [...WORK_ORDER_ITEM_TYPES] },
  tasks: { label: "Tasks", types: ["TASK_DUE"] },
  artwork: { label: "Artwork", types: ["ARTWORK_SLA_DUE"] },
  rfp: { label: "RFP", types: [...RFP_ITEM_TYPES] },
  notes: { label: "Notes", types: ["CUSTOM"] },
};

// shownGroups === null means "no `show` param at all" -- unfiltered, show
// everything. An empty (but non-null) Set is a real, reachable "show
// nothing" state -- see the page's own comment on the __submitted__
// marker for why that distinction needs an extra signal beyond plain
// checkbox presence.
export function isGroupShown(type: CalendarItemType, shownGroups: Set<string> | null): boolean {
  if (shownGroups === null) return true;
  return Object.entries(CALENDAR_FILTER_GROUPS).some(([key, group]) => group.types.includes(type) && shownGroups.has(key));
}

export interface CalendarItem {
  // Stable + unique across every source: `${type}:${sourceRowId}`.
  id: string;
  type: CalendarItemType;
  title: string;
  dateStart: Date;
  // Set only for the two spanning kinds (event window, move window), or a
  // CUSTOM item with an end date filled in. Undefined means "point item."
  dateEnd?: Date;
  href: string;
  tone: CalendarItemTone;
  opportunityId?: string;
  // CalendarEvent only -- the creator, so the UI can gate the delete
  // button without a second query.
  ownerId?: string;
}

type CalendarUser = { id: string; systemRole: SystemRole } & DepartmentUser;

function isAdmin(user: { systemRole: SystemRole }): boolean {
  return user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
}

function inRange(d: Date | null, start: Date, end: Date): d is Date {
  return d !== null && d >= start && d <= end;
}

// Every date field this module aggregates (Opportunity's event/move/ship
// dates, WorkOrder's milestones, Task.dueDate) is set through a plain
// <input type="date">, which the Date constructor parses as UTC midnight
// -- the same trap opportunity-name.ts's own comment documents. Treating
// "today" and any N-days-out range boundary as UTC midnight too keeps
// range filtering aligned with how every source date is actually stored,
// instead of drifting up to a day in any timezone behind UTC.
export function utcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function utcAddDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

const RECURRENCE_OCCURRENCE_CAP = 366;

// Clamped "add one calendar month" -- Jan 31 + 1 month lands on the last
// real day of February (28 or 29), not March 3.
function utcAddMonthClamped(d: Date, months: number): Date {
  const targetMonthIndex = d.getUTCMonth() + months;
  const daysInTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), targetMonthIndex + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInTargetMonth);
  return new Date(Date.UTC(d.getUTCFullYear(), targetMonthIndex, day));
}

// Item kinds that represent a deadline someone owes work against --
// eligible for "overdue" styling when their date has passed. A past
// OPPORTUNITY_EVENT_WINDOW/MOVE_WINDOW just means the show already
// happened (not a missed deadline), and a past CUSTOM note is just
// history, so neither counts as overdue. RFP_MILESTONE is deliberately
// excluded too -- matches dashboard.ts's own `overdue: dateType ===
// "DEADLINE" && date < now` rule, which is never true for a
// milestone-kind fact regardless of date.
const DEADLINE_ITEM_TYPES: readonly CalendarItemType[] = [
  ...WORK_ORDER_ITEM_TYPES,
  "TASK_DUE",
  "ARTWORK_SLA_DUE",
  "OPPORTUNITY_SHIP_DATE",
  "RFP_DEADLINE",
];

export function isOverdueItem(item: CalendarItem, today: Date): boolean {
  return DEADLINE_ITEM_TYPES.includes(item.type) && item.dateStart < today;
}

export async function getCalendarItems(
  user: CalendarUser,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CalendarItem[]> {
  const oppAccess = opportunityAccessWhere(user);
  const artworkOppAccess: Prisma.ArtworkOrderWhereInput = canAccessArtworkOrdersViaDepartment(user)
    ? {}
    : { opportunity: oppAccess };

  const [opportunities, workOrders, tasks, artworkOrders, customEvents, rfpDocuments, deadlineActions] = await Promise.all([
    db.opportunity.findMany({
      where: {
        deletedAt: null,
        ...oppAccess,
        OR: [
          { eventStartDate: { lte: rangeEnd }, eventEndDate: { gte: rangeStart } },
          { eventStartDate: { gte: rangeStart, lte: rangeEnd } },
          { targetMoveIn: { lte: rangeEnd }, targetMoveOut: { gte: rangeStart } },
          { targetMoveIn: { gte: rangeStart, lte: rangeEnd } },
          { shipDate: { gte: rangeStart, lte: rangeEnd } },
        ],
      },
      select: {
        id: true,
        showName: true,
        eventStartDate: true,
        eventEndDate: true,
        targetMoveIn: true,
        targetMoveOut: true,
        shipDate: true,
      },
    }),
    db.workOrder.findMany({
      where: {
        deletedAt: null,
        project: { deletedAt: null, opportunity: oppAccess },
        OR: [
          { depositDueDate: { gte: rangeStart, lte: rangeEnd } },
          { productionMeetingDate: { gte: rangeStart, lte: rangeEnd } },
          { artworkDeadlineDate: { gte: rangeStart, lte: rangeEnd } },
          { balanceDueDate: { gte: rangeStart, lte: rangeEnd } },
          { installDate: { gte: rangeStart, lte: rangeEnd } },
        ],
      },
      select: {
        id: true,
        projectId: true,
        depositDueDate: true,
        productionMeetingDate: true,
        artworkDeadlineDate: true,
        balanceDueDate: true,
        installDate: true,
        project: { select: { opportunityId: true, opportunity: { select: { showName: true } } } },
      },
    }),
    db.task.findMany({
      where: {
        deletedAt: null,
        // A completed task's due date is no longer actionable -- showing
        // it would just be clutter, not a reminder.
        status: { not: "DONE" },
        dueDate: { gte: rangeStart, lte: rangeEnd },
        OR: [{ assignedToId: user.id }, { workOrder: { project: { opportunity: oppAccess } } }],
      },
      select: {
        id: true,
        description: true,
        dueDate: true,
        workOrder: { select: { projectId: true, project: { select: { opportunityId: true } } } },
      },
    }),
    db.artworkOrder.findMany({
      where: {
        deletedAt: null,
        status: "EXPO_PROOF_CHECK",
        slaDueAt: { gte: rangeStart, lte: rangeEnd },
        ...artworkOppAccess,
      },
      select: { id: true, jobCode: true, slaDueAt: true, opportunityId: true },
    }),
    db.calendarEvent.findMany({
      // Date-range and visibility are two independent conditions -- each
      // gets its own OR bucket, combined with AND. A single where object
      // can't hold two different `OR` keys; the second would silently
      // clobber the first via last-write-wins on the duplicate key.
      //
      // A recurring row (recurrence !== NONE) always matches the first
      // bucket regardless of its own date/dateEnd -- its occurrences are
      // expanded and range-checked in JS below, so the SQL date filter
      // isn't the right gate for it. Without this, a weekly note created
      // in January would never even be fetched when viewing a July month.
      where: {
        deletedAt: null,
        AND: [
          {
            OR: [
              { date: { gte: rangeStart, lte: rangeEnd } },
              { dateEnd: { gte: rangeStart, lte: rangeEnd } },
              { recurrence: { not: "NONE" } },
            ],
          },
          isAdmin(user) ? {} : { OR: [{ visibility: "ORG" as const }, { createdByUserId: user.id }] },
        ],
      },
      select: { id: true, title: true, date: true, dateEnd: true, opportunityId: true, createdByUserId: true, recurrence: true },
    }),
    // No date filter in SQL -- extractedSummary is JSON, same reasoning
    // dashboard.ts's own getDashboardData already has for its identical
    // query. Filtering happens in JS against [rangeStart, rangeEnd] below.
    db.document.findMany({
      where: { deletedAt: null, extractionStatus: "COMPLETE", opportunity: { deletedAt: null, ...oppAccess } },
      select: {
        id: true,
        mimeType: true,
        opportunityId: true,
        extractedSummary: true,
        opportunity: { select: { showName: true } },
      },
    }),
    db.deadlineAction.findMany({
      where: { opportunity: oppAccess },
      select: { opportunityId: true, dedupeKey: true },
    }),
  ]);

  const items: CalendarItem[] = [];

  for (const o of opportunities) {
    if (o.eventStartDate && (inRange(o.eventStartDate, rangeStart, rangeEnd) || inRange(o.eventEndDate, rangeStart, rangeEnd))) {
      items.push({
        id: `OPPORTUNITY_EVENT_WINDOW:${o.id}`,
        type: "OPPORTUNITY_EVENT_WINDOW",
        title: o.showName,
        dateStart: o.eventStartDate,
        dateEnd: o.eventEndDate ?? undefined,
        href: `/opportunities/${o.id}`,
        tone: "info",
        opportunityId: o.id,
      });
    }
    if (o.targetMoveIn && (inRange(o.targetMoveIn, rangeStart, rangeEnd) || inRange(o.targetMoveOut, rangeStart, rangeEnd))) {
      items.push({
        id: `OPPORTUNITY_MOVE_WINDOW:${o.id}`,
        type: "OPPORTUNITY_MOVE_WINDOW",
        title: `${o.showName} — move-in/out`,
        dateStart: o.targetMoveIn,
        dateEnd: o.targetMoveOut ?? undefined,
        href: `/opportunities/${o.id}`,
        tone: "warning",
        opportunityId: o.id,
      });
    }
    if (inRange(o.shipDate, rangeStart, rangeEnd)) {
      items.push({
        id: `OPPORTUNITY_SHIP_DATE:${o.id}`,
        type: "OPPORTUNITY_SHIP_DATE",
        title: `${o.showName} — ship date`,
        dateStart: o.shipDate!,
        href: `/opportunities/${o.id}`,
        tone: "neutral",
        opportunityId: o.id,
      });
    }
  }

  const woFields: {
    field: "depositDueDate" | "productionMeetingDate" | "artworkDeadlineDate" | "balanceDueDate" | "installDate";
    type: CalendarItemType;
    tone: CalendarItemTone;
  }[] = [
    { field: "depositDueDate", type: "WORK_ORDER_DEPOSIT_DUE", tone: "warning" },
    { field: "productionMeetingDate", type: "WORK_ORDER_PRODUCTION_MEETING", tone: "info" },
    { field: "artworkDeadlineDate", type: "WORK_ORDER_ARTWORK_DEADLINE", tone: "warning" },
    { field: "balanceDueDate", type: "WORK_ORDER_BALANCE_DUE", tone: "critical" },
    { field: "installDate", type: "WORK_ORDER_INSTALL", tone: "good" },
  ];
  for (const wo of workOrders) {
    for (const { field, type, tone } of woFields) {
      const date = wo[field];
      if (!inRange(date, rangeStart, rangeEnd)) continue;
      items.push({
        id: `${type}:${wo.id}`,
        type,
        title: `${wo.project.opportunity.showName} — ${CALENDAR_ITEM_TYPE_LABELS[type]}`,
        dateStart: date,
        href: `/projects/${wo.projectId}`,
        tone,
        opportunityId: wo.project.opportunityId,
      });
    }
  }

  for (const t of tasks) {
    if (!t.dueDate) continue;
    items.push({
      id: `TASK_DUE:${t.id}`,
      type: "TASK_DUE",
      title: t.description,
      dateStart: t.dueDate,
      href: `/projects/${t.workOrder.projectId}`,
      tone: "neutral",
      opportunityId: t.workOrder.project.opportunityId,
    });
  }

  for (const a of artworkOrders) {
    if (!a.slaDueAt) continue;
    items.push({
      id: `ARTWORK_SLA_DUE:${a.id}`,
      type: "ARTWORK_SLA_DUE",
      title: `Proof check — ${a.jobCode}`,
      dateStart: a.slaDueAt,
      href: `/artwork/${a.id}`,
      tone: "critical",
      opportunityId: a.opportunityId,
    });
  }

  for (const e of customEvents) {
    if (e.recurrence === "NONE") {
      items.push({
        id: `CUSTOM:${e.id}`,
        type: "CUSTOM",
        title: e.title,
        dateStart: e.date,
        dateEnd: e.dateEnd ?? undefined,
        href: `/calendar#event-${e.id}`,
        tone: "neutral",
        opportunityId: e.opportunityId ?? undefined,
        ownerId: e.createdByUserId,
      });
      continue;
    }

    // Recurrence and dateEnd are mutually exclusive (enforced in
    // actions.ts), so every occurrence below is a point item. Forward-only
    // stepping from the anchor date: naturally yields zero occurrences
    // when the anchor is after rangeEnd (a future series viewed in a past
    // range), and walks as far forward as needed -- capped for safety --
    // when the anchor is old and rangeEnd is far out.
    const step = (n: number): Date =>
      e.recurrence === "WEEKLY" ? utcAddDays(e.date, 7 * n) : utcAddMonthClamped(e.date, n);

    for (let n = 0; n < RECURRENCE_OCCURRENCE_CAP; n++) {
      const cur = step(n);
      if (cur > rangeEnd) break;
      if (cur < rangeStart) continue;
      items.push({
        id: `CUSTOM:${e.id}:${cur.toISOString().slice(0, 10)}`,
        type: "CUSTOM",
        title: e.title,
        dateStart: cur,
        dateEnd: undefined,
        href: `/calendar#event-${e.id}`,
        tone: "neutral",
        opportunityId: e.opportunityId ?? undefined,
        ownerId: e.createdByUserId,
      });
    }
  }

  // Two documents from the same RFP package routinely restate the same
  // fact -- deduped with the identical factKey/dedupeKey formula
  // dashboard.ts's own getDashboardData already uses, so the two views
  // never disagree about what counts as "the same fact."
  const actedKeys = new Set(deadlineActions.map((a) => `${a.opportunityId}::${a.dedupeKey}`));
  const seenKeyDates = new Set<string>();
  for (const doc of rfpDocuments) {
    if (!doc.extractedSummary) continue;
    const summary = doc.extractedSummary as unknown as DocumentSummary;
    for (const kd of summary.keyDates) {
      // Older analyses predate dateType (undefined) -- default to
      // MILESTONE, same as dashboard.ts, so a stale record can't falsely
      // alarm as overdue.
      const dateType = kd.dateType ?? "MILESTONE";
      if (dateType === "INFORMATIONAL") continue;

      const date = parseFreeTextDate(kd.date);
      if (!inRange(date, rangeStart, rangeEnd)) continue;

      const factKey = `${kd.label.trim().toLowerCase()}::${date.toISOString().slice(0, 10)}`;
      const dedupeKey = `${doc.opportunityId}::${factKey}`;
      if (seenKeyDates.has(dedupeKey)) continue;
      seenKeyDates.add(dedupeKey);
      // A deadline already dismissed on the Dashboard (Mark submitted /
      // Schedule / Mark paid) must not reappear here -- DeadlineAction is
      // a permanent, global-per-opportunity dismissal, not per-user or
      // per-view.
      if (actedKeys.has(dedupeKey)) continue;

      const type: CalendarItemType = dateType === "DEADLINE" ? "RFP_DEADLINE" : "RFP_MILESTONE";
      items.push({
        id: `${type}:${dedupeKey}`,
        type,
        title: kd.label,
        dateStart: date,
        href: citationHref(doc.opportunityId, doc, kd) ?? `/opportunities/${doc.opportunityId}`,
        tone: type === "RFP_DEADLINE" ? "critical" : "info",
        opportunityId: doc.opportunityId,
      });
    }
  }

  items.sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
  return items;
}

// The default use everywhere except the month grid: "what's coming up,"
// which should also surface a deadline that JUST became overdue -- a
// plain forward-only range (today -> today+N) would silently drop it the
// moment its date passes, exactly the gap that motivated UPCOMING
// DEADLINES' own PAST_DEADLINE_GRACE_DAYS in dashboard.ts. Only
// DEADLINE_ITEM_TYPES are pulled from the backward grace window -- an
// event window that already started, or a CUSTOM note from days ago, has
// no "overdue" meaning and shouldn't resurface just because the window
// widened backward.
const OVERDUE_GRACE_DAYS = 7;

export async function getUpcomingWithOverdue(user: CalendarUser, today: Date, forwardDays: number): Promise<CalendarItem[]> {
  const [pastItems, upcomingItems] = await Promise.all([
    getCalendarItems(user, utcAddDays(today, -OVERDUE_GRACE_DAYS), utcAddDays(today, -1)),
    getCalendarItems(user, today, utcAddDays(today, forwardDays)),
  ]);
  const overdue = pastItems.filter((item) => isOverdueItem(item, today));
  return [...overdue, ...upcomingItems].sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
}
