import { afterAll, afterEach, describe, expect, it } from "vitest";
import { addDays, subDays } from "date-fns";
import { db } from "@/lib/db";
import { getCalendarItems } from "@/lib/calendar";
import { createArtworkOrder } from "@/lib/artwork-order-service";
import { convertOpportunityToProject, startWorkOrder } from "@/lib/project-service";

// Admin bypasses opportunity-scoping entirely (see opportunity-access.ts) --
// used for every test that isn't specifically exercising access scoping.
const ADMIN_USER = { id: "test-admin", systemRole: "ADMIN", departmentCode: null } as const;

const RANGE_START = subDays(new Date(), 30);
const RANGE_END = addDays(new Date(), 30);

afterEach(async () => {
  await db.calendarEvent.deleteMany();
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
