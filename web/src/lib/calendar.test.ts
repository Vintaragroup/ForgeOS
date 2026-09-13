import { afterAll, afterEach, describe, expect, it } from "vitest";
import { addDays, subDays } from "date-fns";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getCalendarItems, getUpcomingWithOverdue, isOverdueItem, utcToday } from "@/lib/calendar";
import { createArtworkOrder } from "@/lib/artwork-order-service";
import { convertOpportunityToProject, startWorkOrder } from "@/lib/project-service";

// Admin bypasses opportunity-scoping entirely (see opportunity-access.ts) --
// used for every test that isn't specifically exercising access scoping.
const ADMIN_USER = { id: "test-admin", systemRole: "ADMIN", departmentCode: null } as const;

const RANGE_START = subDays(new Date(), 30);
const RANGE_END = addDays(new Date(), 30);

afterEach(async () => {
  await db.calendarEvent.deleteMany();
  await db.deadlineAction.deleteMany();
  await db.document.deleteMany();
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.task.deleteMany();
  await db.workOrder.deleteMany();
  await db.project.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity(data: { ownerId?: string | null; stage?: "NEW" | "WON" } = {}) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show", ownerId: data.ownerId ?? null, stage: data.stage ?? "NEW" },
  });
}

async function makeUser(data: { email: string; departmentCode?: string | null; systemRole?: "EMPLOYEE" | "ADMIN" }) {
  return db.user.create({
    data: { email: data.email, name: data.email, departmentCode: data.departmentCode ?? null, systemRole: data.systemRole ?? "EMPLOYEE" },
  });
}

function asAccessUser(user: { id: string; systemRole: string; departmentCode: string | null }) {
  return { id: user.id, systemRole: user.systemRole as "EMPLOYEE" | "ADMIN" | "SUPER_ADMIN", departmentCode: user.departmentCode };
}

// Mirrors dashboard.test.ts's own fixture exactly -- same extractedSummary
// shape, same synthetic-document conventions.
async function makeAnalyzedDocument(opportunityId: string, filename: string, keyDates: unknown[]) {
  return db.document.create({
    data: {
      opportunityId,
      filename,
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: `key-${filename}`,
      documentType: "RFP",
      extractionStatus: "COMPLETE",
      extractedSummary: {
        eventOrProjectName: null,
        venue: null,
        submissionDeadline: null,
        keyDates,
        scopeSummary: [],
        riskFlags: [],
      } as unknown as Prisma.InputJsonValue,
    },
  });
}

function isoDaysFromNow(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("getCalendarItems -- Opportunity dates", () => {
  it("surfaces the event window as a spanning item with real start/end dates, not collapsed to one date", async () => {
    const start = addDays(new Date(), 5);
    const end = addDays(new Date(), 8);
    const opportunity = await db.opportunity.update({
      where: { id: (await makeOpportunity()).id },
      data: { eventStartDate: start, eventEndDate: end },
    });

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    const item = items.find((i) => i.id === `OPPORTUNITY_EVENT_WINDOW:${opportunity.id}`);
    expect(item).toBeDefined();
    expect(item!.dateStart.getTime()).toBe(start.getTime());
    expect(item!.dateEnd?.getTime()).toBe(end.getTime());
  });

  it("surfaces the move-in/move-out window as its own spanning item", async () => {
    const moveIn = addDays(new Date(), 2);
    const moveOut = addDays(new Date(), 3);
    const opportunity = await db.opportunity.update({
      where: { id: (await makeOpportunity()).id },
      data: { targetMoveIn: moveIn, targetMoveOut: moveOut },
    });

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    const item = items.find((i) => i.id === `OPPORTUNITY_MOVE_WINDOW:${opportunity.id}`);
    expect(item).toBeDefined();
    expect(item!.dateStart.getTime()).toBe(moveIn.getTime());
    expect(item!.dateEnd?.getTime()).toBe(moveOut.getTime());
  });

  it("surfaces the ship date as a point item with no dateEnd", async () => {
    const ship = addDays(new Date(), 1);
    const opportunity = await db.opportunity.update({
      where: { id: (await makeOpportunity()).id },
      data: { shipDate: ship },
    });

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    const item = items.find((i) => i.id === `OPPORTUNITY_SHIP_DATE:${opportunity.id}`);
    expect(item).toBeDefined();
    expect(item!.dateEnd).toBeUndefined();
  });
});

describe("getCalendarItems -- WorkOrder milestones", () => {
  const fields = [
    ["depositDueDate", "WORK_ORDER_DEPOSIT_DUE"],
    ["productionMeetingDate", "WORK_ORDER_PRODUCTION_MEETING"],
    ["artworkDeadlineDate", "WORK_ORDER_ARTWORK_DEADLINE"],
    ["balanceDueDate", "WORK_ORDER_BALANCE_DUE"],
    ["installDate", "WORK_ORDER_INSTALL"],
  ] as const;

  for (const [field, type] of fields) {
    it(`surfaces ${field} as a ${type} item`, async () => {
      const opportunity = await makeOpportunity({ stage: "WON" });
      const project = await convertOpportunityToProject(opportunity.id);
      const workOrder = await startWorkOrder(project.id);
      const date = addDays(new Date(), 4);
      await db.workOrder.update({ where: { id: workOrder.id }, data: { [field]: date } });

      const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
      const item = items.find((i) => i.id === `${type}:${workOrder.id}`);
      expect(item).toBeDefined();
      expect(item!.type).toBe(type);
      expect(item!.dateStart.getTime()).toBe(date.getTime());
    });
  }
});

describe("getCalendarItems -- Task scoping", () => {
  async function makeTaskFixture() {
    const owner = await makeUser({ email: "owner@test.com" });
    const assignee = await makeUser({ email: "assignee@test.com" });
    const stranger = await makeUser({ email: "stranger@test.com" });
    const opportunity = await makeOpportunity({ ownerId: owner.id, stage: "WON" });
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const task = await db.task.create({
      data: { workOrderId: workOrder.id, description: "Cut vinyl", dueDate: addDays(new Date(), 3), assignedToId: assignee.id },
    });
    return { owner, assignee, stranger, task };
  }

  it("is visible to the assignee even without opportunity access", async () => {
    const { assignee, task } = await makeTaskFixture();
    const items = await getCalendarItems(asAccessUser(assignee), RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `TASK_DUE:${task.id}`)).toBe(true);
  });

  it("is visible to the opportunity owner even when not the assignee", async () => {
    const { owner, task } = await makeTaskFixture();
    const items = await getCalendarItems(asAccessUser(owner), RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `TASK_DUE:${task.id}`)).toBe(true);
  });

  it("is hidden from a user who is neither assignee nor has opportunity access", async () => {
    const { stranger, task } = await makeTaskFixture();
    const items = await getCalendarItems(asAccessUser(stranger), RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `TASK_DUE:${task.id}`)).toBe(false);
  });

  it("is always visible to an admin", async () => {
    const { task } = await makeTaskFixture();
    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `TASK_DUE:${task.id}`)).toBe(true);
  });

  it("excludes a task already marked DONE, even within the queried range", async () => {
    const { task } = await makeTaskFixture();
    await db.task.update({ where: { id: task.id }, data: { status: "DONE" } });
    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `TASK_DUE:${task.id}`)).toBe(false);
  });
});

describe("getCalendarItems -- ArtworkOrder SLA", () => {
  async function makeArtworkOrderFixture(ownerId: string | null) {
    const opportunity = await makeOpportunity({ ownerId });
    const order = await createArtworkOrder(opportunity.id);
    return db.artworkOrder.update({
      where: { id: order.id },
      data: { status: "EXPO_PROOF_CHECK", slaDueAt: addDays(new Date(), 1) },
    });
  }

  it("only surfaces while status is EXPO_PROOF_CHECK", async () => {
    const opportunity = await makeOpportunity();
    const order = await createArtworkOrder(opportunity.id);
    await db.artworkOrder.update({ where: { id: order.id }, data: { slaDueAt: addDays(new Date(), 1) } }); // status stays INVITED

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `ARTWORK_SLA_DUE:${order.id}`)).toBe(false);
  });

  it("is visible org-wide to a GR-department user, even without opportunity access", async () => {
    const owner = await makeUser({ email: "owner@test.com" });
    const grUser = await makeUser({ email: "gr@test.com", departmentCode: "GR" });
    const order = await makeArtworkOrderFixture(owner.id);

    const items = await getCalendarItems(asAccessUser(grUser), RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `ARTWORK_SLA_DUE:${order.id}`)).toBe(true);
  });

  it("is hidden from a non-GR user with no opportunity access", async () => {
    const owner = await makeUser({ email: "owner@test.com" });
    const stranger = await makeUser({ email: "stranger@test.com" });
    const order = await makeArtworkOrderFixture(owner.id);

    const items = await getCalendarItems(asAccessUser(stranger), RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `ARTWORK_SLA_DUE:${order.id}`)).toBe(false);
  });
});

describe("getCalendarItems -- CalendarEvent visibility", () => {
  it("a PRIVATE event is visible only to its creator and an admin", async () => {
    const creator = await makeUser({ email: "creator@test.com" });
    const other = await makeUser({ email: "other@test.com" });
    const event = await db.calendarEvent.create({
      data: { title: "1:1", date: addDays(new Date(), 1), visibility: "PRIVATE", createdByUserId: creator.id },
    });

    expect((await getCalendarItems(asAccessUser(creator), RANGE_START, RANGE_END)).some((i) => i.id === `CUSTOM:${event.id}`)).toBe(true);
    expect((await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END)).some((i) => i.id === `CUSTOM:${event.id}`)).toBe(true);
    expect((await getCalendarItems(asAccessUser(other), RANGE_START, RANGE_END)).some((i) => i.id === `CUSTOM:${event.id}`)).toBe(false);
  });

  it("an ORG event is visible to everyone", async () => {
    const creator = await makeUser({ email: "creator2@test.com" });
    const other = await makeUser({ email: "other2@test.com" });
    const event = await db.calendarEvent.create({
      data: { title: "All-hands", date: addDays(new Date(), 1), visibility: "ORG", createdByUserId: creator.id },
    });

    expect((await getCalendarItems(asAccessUser(other), RANGE_START, RANGE_END)).some((i) => i.id === `CUSTOM:${event.id}`)).toBe(true);
  });

  it("excludes an event whose date falls outside the queried range", async () => {
    const creator = await makeUser({ email: "creator3@test.com" });
    const event = await db.calendarEvent.create({
      data: { title: "Far future", date: addDays(new Date(), 90), visibility: "ORG", createdByUserId: creator.id },
    });

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.id === `CUSTOM:${event.id}`)).toBe(false);
  });
});

describe("isOverdueItem", () => {
  const today = utcToday();

  it("is true for a deadline-type item whose date has passed", () => {
    const item = { id: "x", type: "TASK_DUE" as const, title: "x", dateStart: subDays(today, 1), href: "/x", tone: "neutral" as const };
    expect(isOverdueItem(item, today)).toBe(true);
  });

  it("is false for a deadline-type item still in the future", () => {
    const item = { id: "x", type: "TASK_DUE" as const, title: "x", dateStart: addDays(today, 1), href: "/x", tone: "neutral" as const };
    expect(isOverdueItem(item, today)).toBe(false);
  });

  it("is false for a past OPPORTUNITY_EVENT_WINDOW -- a show that already happened isn't a missed deadline", () => {
    const item = { id: "x", type: "OPPORTUNITY_EVENT_WINDOW" as const, title: "x", dateStart: subDays(today, 5), href: "/x", tone: "info" as const };
    expect(isOverdueItem(item, today)).toBe(false);
  });

  it("is false for a past CUSTOM note", () => {
    const item = { id: "x", type: "CUSTOM" as const, title: "x", dateStart: subDays(today, 5), href: "/x", tone: "neutral" as const };
    expect(isOverdueItem(item, today)).toBe(false);
  });
});

describe("getUpcomingWithOverdue", () => {
  it("surfaces a task due date that only just became overdue, within the grace window", async () => {
    const opportunity = await makeOpportunity({ stage: "WON" });
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const task = await db.task.create({
      data: { workOrderId: workOrder.id, description: "Overdue task", dueDate: subDays(new Date(), 2) },
    });

    const items = await getUpcomingWithOverdue(ADMIN_USER, utcToday(), 7);
    const item = items.find((i) => i.id === `TASK_DUE:${task.id}`);
    expect(item).toBeDefined();
    expect(isOverdueItem(item!, utcToday())).toBe(true);
  });

  it("does not resurface a fully-past, non-deadline item (an event window that already happened)", async () => {
    const today = utcToday();
    const opportunity = await db.opportunity.update({
      where: { id: (await makeOpportunity()).id },
      data: { eventStartDate: subDays(today, 5), eventEndDate: subDays(today, 4) },
    });

    const items = await getUpcomingWithOverdue(ADMIN_USER, today, 7);
    expect(items.some((i) => i.id === `OPPORTUNITY_EVENT_WINDOW:${opportunity.id}`)).toBe(false);
  });
});

describe("getCalendarItems -- RFP key dates", () => {
  it("excludes an INFORMATIONAL fact entirely", async () => {
    const opportunity = await makeOpportunity();
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "RFP Sent", date: isoDaysFromNow(1), dateType: "INFORMATIONAL", sourceQuote: "x", pageNumber: null },
    ]);

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.type === "RFP_DEADLINE" || i.type === "RFP_MILESTONE")).toBe(false);
  });

  it("collapses the same fact restated in two documents into one item", async () => {
    const opportunity = await makeOpportunity();
    const keyDate = { label: "Bidder Questions Due", date: isoDaysFromNow(10), dateType: "DEADLINE", sourceQuote: "x", pageNumber: null };
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [keyDate]);
    await makeAnalyzedDocument(opportunity.id, "Appendix A.pdf", [keyDate]);

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    const matches = items.filter((i) => i.type === "RFP_DEADLINE" && i.title === "Bidder Questions Due");
    expect(matches).toHaveLength(1);
  });

  it("excludes a fact already dismissed via a matching DeadlineAction row", async () => {
    const opportunity = await makeOpportunity();
    const date = isoDaysFromNow(10);
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "Bidder Questions Due", date, dateType: "DEADLINE", sourceQuote: "x", pageNumber: null },
    ]);
    const dedupeKey = `bidder questions due::${new Date(date).toISOString().slice(0, 10)}`;
    await db.deadlineAction.create({
      data: { opportunityId: opportunity.id, dedupeKey, status: "SUBMITTED" },
    });

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.type === "RFP_DEADLINE")).toBe(false);
  });

  it("a DEADLINE-kind fact is overdue-eligible; a MILESTONE-kind fact is never overdue", async () => {
    const opportunity = await makeOpportunity();
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "Past Deadline", date: isoDaysFromNow(-2), dateType: "DEADLINE", sourceQuote: "x", pageNumber: null },
      { label: "Past Milestone", date: isoDaysFromNow(-2), dateType: "MILESTONE", sourceQuote: "x", pageNumber: null },
    ]);

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    const deadline = items.find((i) => i.title === "Past Deadline");
    const milestone = items.find((i) => i.title === "Past Milestone");
    expect(deadline).toBeDefined();
    expect(milestone).toBeDefined();
    expect(isOverdueItem(deadline!, utcToday())).toBe(true);
    expect(isOverdueItem(milestone!, utcToday())).toBe(false);
  });

  it("resolves href via citationHref when the document is a paginated PDF, falling back to the opportunity page otherwise", async () => {
    const opportunity = await makeOpportunity();
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "With Page", date: isoDaysFromNow(3), dateType: "DEADLINE", sourceQuote: "x", pageNumber: 2 },
      { label: "No Page", date: isoDaysFromNow(3), dateType: "DEADLINE", sourceQuote: null, pageNumber: null },
    ]);

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    const withPage = items.find((i) => i.title === "With Page");
    const noPage = items.find((i) => i.title === "No Page");
    expect(withPage?.href).toContain("page=2");
    expect(noPage?.href).toBe(`/opportunities/${opportunity.id}`);
  });

  it("excludes a fact whose parsed date falls outside the queried range", async () => {
    const opportunity = await makeOpportunity();
    await makeAnalyzedDocument(opportunity.id, "RFP.pdf", [
      { label: "Far future", date: isoDaysFromNow(90), dateType: "DEADLINE", sourceQuote: "x", pageNumber: null },
    ]);

    const items = await getCalendarItems(ADMIN_USER, RANGE_START, RANGE_END);
    expect(items.some((i) => i.title === "Far future")).toBe(false);
  });
});
