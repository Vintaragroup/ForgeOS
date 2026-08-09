import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  addShipment,
  addTask,
  convertOpportunityToProject,
  deleteShipment,
  deleteTask,
  startWorkOrder,
  updateProjectDetails,
  updateShipment,
  updateTaskStatus,
  updateWorkOrder,
} from "@/lib/project-service";

afterEach(async () => {
  await db.task.deleteMany();
  await db.shipment.deleteMany();
  await db.workOrder.deleteMany();
  await db.project.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeWonOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({
    data: { companyId: company.id, showName: "Test Show", stage: "WON" },
  });
}

describe("convertOpportunityToProject", () => {
  it("creates a Project linked to the opportunity, without touching its stage", async () => {
    const opportunity = await makeWonOpportunity();

    const project = await convertOpportunityToProject(opportunity.id);

    expect(project.opportunityId).toBe(opportunity.id);
    expect(project.status).toBe("ACTIVE");

    const reloaded = await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(reloaded.stage).toBe("WON"); // unchanged
  });
});

describe("updateProjectDetails", () => {
  it("updates job number, status, and show dates", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);

    const updated = await updateProjectDetails(project.id, {
      jobNumber: "J-1001",
      status: "COMPLETE",
      showStartDate: new Date("2026-09-01"),
      showEndDate: new Date("2026-09-03"),
    });

    expect(updated.jobNumber).toBe("J-1001");
    expect(updated.status).toBe("COMPLETE");
    expect(updated.showStartDate?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});

describe("startWorkOrder / updateWorkOrder", () => {
  it("creates a WorkOrder in DRAFT status and updates its timeline", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);

    const workOrder = await startWorkOrder(project.id);
    expect(workOrder.projectId).toBe(project.id);
    expect(workOrder.status).toBe("DRAFT");

    const updated = await updateWorkOrder(workOrder.id, {
      status: "IN_PRODUCTION",
      depositDueDate: new Date("2026-08-15"),
      installDate: new Date("2026-09-01"),
    });

    expect(updated.status).toBe("IN_PRODUCTION");
    expect(updated.depositDueDate?.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(updated.installDate?.toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});

describe("startWorkOrder auto-fills installDate from an analyzed document's key dates", () => {
  it("prefers 'Start of Installation' over a wave sub-milestone or the completion date", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "Appendix A.pdf",
        mimeType: "application/pdf",
        sizeBytes: 100,
        storageKey: "test-key",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
        extractedSummary: {
          eventOrProjectName: null,
          venue: null,
          submissionDeadline: null,
          keyDates: [
            { label: "Wave 1 Installation", date: "January 5, 2027", dateType: "MILESTONE", sourceQuote: "x", pageNumber: null },
            { label: "Start of Installation", date: "January 1, 2027", dateType: "MILESTONE", sourceQuote: "x", pageNumber: null },
            { label: "Installation Complete", date: "January 20, 2027", dateType: "MILESTONE", sourceQuote: "x", pageNumber: null },
          ],
          scopeSummary: [],
          riskFlags: [],
        },
      },
    });

    const workOrder = await startWorkOrder(project.id);
    expect(workOrder.installDate?.toISOString().slice(0, 10)).toBe("2027-01-01");
  });

  it("leaves installDate null when no analyzed document has an install-start key date", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);

    const workOrder = await startWorkOrder(project.id);
    expect(workOrder.installDate).toBeNull();
  });
});

describe("addTask / updateTaskStatus / deleteTask", () => {
  it("creates a task with a department code, assignee, and due date", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const user = await db.user.create({ data: { name: "Production Lead", email: `p-${Date.now()}@example.com` } });

    const task = await addTask(workOrder.id, {
      description: "Fabricate flooring",
      departmentCode: "EF",
      dueDate: new Date("2026-08-25"),
      assignedToId: user.id,
    });

    expect(task.workOrderId).toBe(workOrder.id);
    expect(task.departmentCode).toBe("EF");
    expect(task.status).toBe("TODO");
    expect(task.assignedToId).toBe(user.id);
  });

  it("updates task status independently of other fields", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const task = await addTask(workOrder.id, { description: "Design time" });

    const updated = await updateTaskStatus(task.id, "IN_PROGRESS");
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.description).toBe("Design time");
  });

  it("deletes a task", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const task = await addTask(workOrder.id, { description: "Packing" });

    await deleteTask(task.id);

    const found = await db.task.findUnique({ where: { id: task.id } });
    expect(found).toBeNull();
  });
});

describe("addShipment / updateShipment / deleteShipment", () => {
  it("creates a shipment in PLANNED status with carrier and load-list details", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);

    const shipment = await addShipment(workOrder.id, {
      carrier: "ABC Freight",
      loadListNote: "2 crates, 1 skid",
      shipDate: new Date("2026-08-28"),
    });

    expect(shipment.workOrderId).toBe(workOrder.id);
    expect(shipment.status).toBe("PLANNED");
    expect(shipment.carrier).toBe("ABC Freight");
  });

  it("updates shipment status and tracking reference", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const shipment = await addShipment(workOrder.id, { carrier: "ABC Freight" });

    const updated = await updateShipment(shipment.id, { status: "SHIPPED", trackingRef: "TRK-12345" });

    expect(updated.status).toBe("SHIPPED");
    expect(updated.trackingRef).toBe("TRK-12345");
  });

  it("deletes a shipment", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const shipment = await addShipment(workOrder.id, { carrier: "ABC Freight" });

    await deleteShipment(shipment.id);

    const found = await db.shipment.findUnique({ where: { id: shipment.id } });
    expect(found).toBeNull();
  });
});

// docs/migration-plan.md Phase 5 exit criteria: "a won project can be
// tracked from deposit through installation entirely in ForgeOS, with
// task ownership and due dates visible to production staff." Exercises
// the full chain end to end -- Opportunity(WON) -> Project -> WorkOrder ->
// Task/Shipment -- through the real DB-backed service, not just each
// function in isolation.
describe("acceptance: a won opportunity carries through to a trackable project", () => {
  it("goes from WON opportunity to a fully-tracked production job", async () => {
    const opportunity = await makeWonOpportunity();

    const project = await convertOpportunityToProject(opportunity.id);
    await updateProjectDetails(project.id, { jobNumber: "J-2001" });

    const workOrder = await startWorkOrder(project.id);
    await updateWorkOrder(workOrder.id, {
      status: "IN_PRODUCTION",
      depositDueDate: new Date("2026-08-15"),
      installDate: new Date("2026-09-10"),
    });

    const user = await db.user.create({ data: { name: "Production Lead", email: `pl-${Date.now()}@example.com` } });
    const task = await addTask(workOrder.id, {
      description: "Fabricate flooring",
      departmentCode: "EF",
      dueDate: new Date("2026-09-01"),
      assignedToId: user.id,
    });
    await updateTaskStatus(task.id, "IN_PROGRESS");

    const shipment = await addShipment(workOrder.id, { carrier: "ABC Freight", loadListNote: "2 crates" });
    await updateShipment(shipment.id, { status: "SHIPPED", trackingRef: "TRK-99" });

    // Read back the whole tree the way the /projects/[id] page does, and
    // confirm every piece of the chain landed correctly.
    const reloaded = await db.project.findUniqueOrThrow({
      where: { id: project.id },
      include: {
        opportunity: true,
        workOrders: { include: { tasks: { include: { assignedTo: true } }, shipments: true } },
      },
    });

    expect(reloaded.opportunity.stage).toBe("WON");
    expect(reloaded.jobNumber).toBe("J-2001");
    expect(reloaded.workOrders).toHaveLength(1);

    const reloadedWorkOrder = reloaded.workOrders[0];
    expect(reloadedWorkOrder.status).toBe("IN_PRODUCTION");
    expect(reloadedWorkOrder.tasks).toHaveLength(1);
    expect(reloadedWorkOrder.tasks[0]).toMatchObject({ status: "IN_PROGRESS", departmentCode: "EF" });
    expect(reloadedWorkOrder.tasks[0].assignedTo?.name).toBe("Production Lead");
    expect(reloadedWorkOrder.shipments).toHaveLength(1);
    expect(reloadedWorkOrder.shipments[0]).toMatchObject({ status: "SHIPPED", trackingRef: "TRK-99" });
  });
});
