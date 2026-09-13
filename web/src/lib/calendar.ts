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
  TASK_DUE: "Task due",
  ARTWORK_SLA_DUE: "Artwork proof SLA",
  CUSTOM: "Note",
};

// Reuses StatusChip's tone vocabulary (@/components/ui) for color
// consistency, even though the calendar page renders its own markup, not
// StatusChip itself.
export type CalendarItemTone = "neutral" | "info" | "warning" | "good" | "critical";

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

export async function getCalendarItems(
  user: CalendarUser,
  rangeStart: Date,
  rangeEnd: Date,
): Promise<CalendarItem[]> {
  const oppAccess = opportunityAccessWhere(user);
  const artworkOppAccess: Prisma.ArtworkOrderWhereInput = canAccessArtworkOrdersViaDepartment(user)
    ? {}
    : { opportunity: oppAccess };

  const [opportunities, workOrders, tasks, artworkOrders, customEvents] = await Promise.all([
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
      where: {
        deletedAt: null,
        AND: [
          { OR: [{ date: { gte: rangeStart, lte: rangeEnd } }, { dateEnd: { gte: rangeStart, lte: rangeEnd } }] },
          isAdmin(user) ? {} : { OR: [{ visibility: "ORG" as const }, { createdByUserId: user.id }] },
        ],
      },
      select: { id: true, title: true, date: true, dateEnd: true, opportunityId: true, createdByUserId: true },
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
  }

  items.sort((a, b) => a.dateStart.getTime() - b.dateStart.getTime());
  return items;
}
