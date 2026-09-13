import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getTasksForUser } from "@/lib/tasks";
import { convertOpportunityToProject, startWorkOrder } from "@/lib/project-service";

const ADMIN_USER = { id: "test-admin", systemRole: "ADMIN" } as const;

afterEach(async () => {
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

async function makeUser(email: string, systemRole: "EMPLOYEE" | "ADMIN" = "EMPLOYEE") {
  return db.user.create({ data: { email, name: email, systemRole } });
}

async function makeTaskFixture(ownerId: string | null, assignedToId: string | null, status: "TODO" | "DONE" = "TODO") {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show", ownerId, stage: "WON" },
  });
  const project = await convertOpportunityToProject(opportunity.id);
  const workOrder = await startWorkOrder(project.id);
  const task = await db.task.create({
    data: { workOrderId: workOrder.id, description: "Cut vinyl", assignedToId, status },
  });
  return { opportunity, project, workOrder, task };
}

describe("getTasksForUser -- mineOnly", () => {
  it("returns a task assigned to the caller even on an opportunity they don't otherwise have access to", async () => {
    const owner = await makeUser("owner@test.com");
    const assignee = await makeUser("assignee@test.com");
    const { task } = await makeTaskFixture(owner.id, assignee.id);

    const items = await getTasksForUser({ id: assignee.id, systemRole: "EMPLOYEE" }, { mineOnly: true, includeCompleted: false });
    expect(items.some((t) => t.id === task.id)).toBe(true);
  });

  it("excludes a task NOT assigned to the caller, even on an opportunity they own", async () => {
    const owner = await makeUser("owner2@test.com");
    const someoneElse = await makeUser("someone2@test.com");
    const { task } = await makeTaskFixture(owner.id, someoneElse.id);

    const items = await getTasksForUser({ id: owner.id, systemRole: "EMPLOYEE" }, { mineOnly: true, includeCompleted: false });
    expect(items.some((t) => t.id === task.id)).toBe(false);
  });
});

describe("getTasksForUser -- mineOnly: false", () => {
  it("a non-admin sees the OR of assigned-to-me and opportunity-access-scoped tasks", async () => {
    const owner = await makeUser("owner3@test.com");
    const assignee = await makeUser("assignee3@test.com");
    const stranger = await makeUser("stranger3@test.com");
    const { task: assignedTask } = await makeTaskFixture(owner.id, assignee.id);
    const { task: ownedTask } = await makeTaskFixture(owner.id, null);

    const asAssignee = await getTasksForUser({ id: assignee.id, systemRole: "EMPLOYEE" }, { mineOnly: false, includeCompleted: false });
    expect(asAssignee.some((t) => t.id === assignedTask.id)).toBe(true);

    const asOwner = await getTasksForUser({ id: owner.id, systemRole: "EMPLOYEE" }, { mineOnly: false, includeCompleted: false });
    expect(asOwner.some((t) => t.id === ownedTask.id)).toBe(true);

    const asStranger = await getTasksForUser({ id: stranger.id, systemRole: "EMPLOYEE" }, { mineOnly: false, includeCompleted: false });
    expect(asStranger.some((t) => t.id === assignedTask.id || t.id === ownedTask.id)).toBe(false);
  });

  it("an admin sees every task regardless of ownership or assignment", async () => {
    const owner = await makeUser("owner4@test.com");
    const { task } = await makeTaskFixture(owner.id, null);

    const items = await getTasksForUser(ADMIN_USER, { mineOnly: false, includeCompleted: false });
    expect(items.some((t) => t.id === task.id)).toBe(true);
  });
});

describe("getTasksForUser -- includeCompleted", () => {
  it("excludes a DONE task by default and includes it when includeCompleted is true", async () => {
    const owner = await makeUser("owner5@test.com");
    const { task } = await makeTaskFixture(owner.id, null, "DONE");

    const excluded = await getTasksForUser(ADMIN_USER, { mineOnly: false, includeCompleted: false });
    expect(excluded.some((t) => t.id === task.id)).toBe(false);

    const included = await getTasksForUser(ADMIN_USER, { mineOnly: false, includeCompleted: true });
    expect(included.some((t) => t.id === task.id)).toBe(true);
  });
});

describe("getTasksForUser -- resolved fields", () => {
  it("resolves showName/companyName through the WorkOrder->Project->Opportunity->Company chain", async () => {
    const owner = await makeUser("owner6@test.com");
    const { task, opportunity } = await makeTaskFixture(owner.id, null);

    const items = await getTasksForUser(ADMIN_USER, { mineOnly: false, includeCompleted: false });
    const item = items.find((t) => t.id === task.id);
    expect(item).toBeDefined();
    expect(item!.opportunityId).toBe(opportunity.id);
    expect(item!.showName).toBe("Test Show");
    expect(item!.companyName).toBe("Test Co");
  });
});

describe("getTasksForUser -- canManage", () => {
  it("is false for an assignee-only viewer with no opportunity access -- avoids offering an update/delete form that would fail", async () => {
    const owner = await makeUser("owner7@test.com");
    const assignee = await makeUser("assignee7@test.com");
    const { task } = await makeTaskFixture(owner.id, assignee.id);

    const items = await getTasksForUser({ id: assignee.id, systemRole: "EMPLOYEE" }, { mineOnly: true, includeCompleted: false });
    const item = items.find((t) => t.id === task.id);
    expect(item?.canManage).toBe(false);
  });

  it("is true for the opportunity owner", async () => {
    const owner = await makeUser("owner8@test.com");
    const { task } = await makeTaskFixture(owner.id, null);

    const items = await getTasksForUser({ id: owner.id, systemRole: "EMPLOYEE" }, { mineOnly: false, includeCompleted: false });
    const item = items.find((t) => t.id === task.id);
    expect(item?.canManage).toBe(true);
  });

  it("is true for an admin regardless of ownership", async () => {
    const owner = await makeUser("owner9@test.com");
    const { task } = await makeTaskFixture(owner.id, null);

    const items = await getTasksForUser(ADMIN_USER, { mineOnly: false, includeCompleted: false });
    const item = items.find((t) => t.id === task.id);
    expect(item?.canManage).toBe(true);
  });
});
