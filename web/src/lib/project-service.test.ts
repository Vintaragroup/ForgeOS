import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import {
  addShipment,
  addTask,
  convertOpportunityToProject,
  deleteShipment,
  deleteTask,
  linkLineItemToTask,
  resolveProductionEstimateVersion,
  startWorkOrder,
  unlinkLineItemFromTask,
  updateProjectDetails,
  updateShipment,
  updateTaskStatus,
  updateWorkOrder,
} from "@/lib/project-service";
import { addLineItem, addSection, createEstimateVersion, lockEstimateVersion } from "@/lib/estimate-service";
import { buildEmptyMilestones, type TimelineData, type TimelineMilestone } from "@/lib/timeline-service";

afterEach(async () => {
  await db.task.deleteMany();
  await db.shipment.deleteMany();
  await db.workOrder.deleteMany();
  await db.project.deleteMany();
  await db.lineItemAuditLog.deleteMany();
  await db.lineItem.deleteMany();
  await db.estimateSection.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
  await db.category.deleteMany();
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

function withDate(milestones: TimelineMilestone[], type: TimelineMilestone["type"], date: Date, confirmed: boolean): TimelineMilestone[] {
  return milestones.map((m) => (m.type === type ? { ...m, date: date.toISOString(), confirmed } : m));
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

  it("accepts an optional jobNumber, captured at the moment of conversion", async () => {
    const opportunity = await makeWonOpportunity();

    const project = await convertOpportunityToProject(opportunity.id, { jobNumber: "J-3001" });

    expect(project.jobNumber).toBe("J-3001");
  });

  it("leaves jobNumber null when the estimator doesn't have it yet", async () => {
    const opportunity = await makeWonOpportunity();

    const project = await convertOpportunityToProject(opportunity.id);

    expect(project.jobNumber).toBeNull();
  });

  it("rejects a non-WON opportunity -- this was previously only enforced by the page's own conditional rendering", async () => {
    const company = await db.company.create({ data: { name: "Test Co" } });
    const opportunity = await db.opportunity.create({
      data: { companyId: company.id, showName: "Test Show", stage: "ESTIMATING" },
    });

    await expect(convertOpportunityToProject(opportunity.id)).rejects.toThrow(
      "Only a WON opportunity can be converted to a Project.",
    );

    const projectCount = await db.project.count({ where: { opportunityId: opportunity.id } });
    expect(projectCount).toBe(0);
  });

  // Was previously only a caller-enforced invariant (the manual "Convert
  // to Project" button only ever renders when opportunity.projects.length
  // === 0) -- made structural so signProposal (proposal-service.ts) can
  // safely call this without duplicating that same check itself.
  it("is idempotent -- a second call converges on the existing Project instead of creating a duplicate", async () => {
    const opportunity = await makeWonOpportunity();

    const first = await convertOpportunityToProject(opportunity.id, { jobNumber: "J-1001" });
    const second = await convertOpportunityToProject(opportunity.id, { jobNumber: "J-9999" });

    expect(second.id).toBe(first.id);
    expect(second.jobNumber).toBe("J-1001"); // the second call's jobNumber is ignored, not applied
    const projectCount = await db.project.count({ where: { opportunityId: opportunity.id } });
    expect(projectCount).toBe(1);
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

    const updated = await updateWorkOrder(project.id, workOrder.id, {
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

describe("startWorkOrder inherits production dates from the Opportunity's own Timeline", () => {
  async function seedTimeline(opportunityId: string, milestones: TimelineMilestone[]) {
    const data: TimelineData = { generatedAt: new Date().toISOString(), milestones };
    await db.opportunity.update({
      where: { id: opportunityId },
      data: { timelineMilestones: data as unknown as Prisma.InputJsonValue },
    });
  }

  it("prefills all 4 previously-unfillable dates, including an unconfirmed AI-suggested one", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    let milestones = buildEmptyMilestones();
    milestones = withDate(milestones, "DEPOSIT_DUE", new Date("2026-08-15"), true);
    milestones = withDate(milestones, "PRODUCTION_MEETING", new Date("2026-08-20"), false);
    milestones = withDate(milestones, "ARTWORK_DEADLINE", new Date("2026-12-01"), false);
    milestones = withDate(milestones, "BALANCE_DUE", new Date("2026-12-10"), true);
    await seedTimeline(opportunity.id, milestones);

    const workOrder = await startWorkOrder(project.id);

    expect(workOrder.depositDueDate?.toISOString().slice(0, 10)).toBe("2026-08-15");
    expect(workOrder.productionMeetingDate?.toISOString().slice(0, 10)).toBe("2026-08-20");
    expect(workOrder.artworkDeadlineDate?.toISOString().slice(0, 10)).toBe("2026-12-01");
    expect(workOrder.balanceDueDate?.toISOString().slice(0, 10)).toBe("2026-12-10");
  });

  it("prefers the Timeline's own INSTALLATION date over the document key-dates scan", async () => {
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
            { label: "Start of Installation", date: "January 1, 2027", dateType: "MILESTONE", sourceQuote: "x", pageNumber: null },
          ],
          scopeSummary: [],
          riskFlags: [],
        },
      },
    });
    const milestones = withDate(buildEmptyMilestones(), "INSTALLATION", new Date("2027-01-15"), true);
    await seedTimeline(opportunity.id, milestones);

    const workOrder = await startWorkOrder(project.id);

    // The Timeline's Jan 15 wins, not the document scan's Jan 1 -- real
    // precedence, not just "used when the other source is missing."
    expect(workOrder.installDate?.toISOString().slice(0, 10)).toBe("2027-01-15");
  });

  it("falls back to the document key-dates scan when no Timeline has ever been generated", async () => {
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
            { label: "Start of Installation", date: "January 1, 2027", dateType: "MILESTONE", sourceQuote: "x", pageNumber: null },
          ],
          scopeSummary: [],
          riskFlags: [],
        },
      },
    });
    // timelineMilestones is left null -- never generated for this opportunity.

    const workOrder = await startWorkOrder(project.id);

    expect(workOrder.installDate?.toISOString().slice(0, 10)).toBe("2027-01-01");
    expect(workOrder.depositDueDate).toBeNull();
    expect(workOrder.productionMeetingDate).toBeNull();
    expect(workOrder.artworkDeadlineDate).toBeNull();
    expect(workOrder.balanceDueDate).toBeNull();
  });
});

describe("addTask / updateTaskStatus / deleteTask", () => {
  it("creates a task with a department code, assignee, and due date", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const user = await db.user.create({ data: { name: "Production Lead", email: `p-${Date.now()}@example.com` } });

    const task = await addTask(project.id, workOrder.id, {
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
    const task = await addTask(project.id, workOrder.id, { description: "Design time" });

    const updated = await updateTaskStatus(project.id, task.id, "IN_PROGRESS");
    expect(updated.status).toBe("IN_PROGRESS");
    expect(updated.description).toBe("Design time");
  });

  it("deletes a task", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const task = await addTask(project.id, workOrder.id, { description: "Packing" });

    await deleteTask(project.id, task.id);

    const found = await db.task.findUnique({ where: { id: task.id } });
    expect(found).toBeNull();
  });
});

describe("addShipment / updateShipment / deleteShipment", () => {
  it("creates a shipment in PLANNED status with carrier and load-list details", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);

    const shipment = await addShipment(project.id, workOrder.id, {
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
    const shipment = await addShipment(project.id, workOrder.id, { carrier: "ABC Freight" });

    const updated = await updateShipment(project.id, shipment.id, { status: "SHIPPED", trackingRef: "TRK-12345" });

    expect(updated.status).toBe("SHIPPED");
    expect(updated.trackingRef).toBe("TRK-12345");
  });

  it("deletes a shipment", async () => {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const shipment = await addShipment(project.id, workOrder.id, { carrier: "ABC Freight" });

    await deleteShipment(project.id, shipment.id);

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
    await updateWorkOrder(project.id, workOrder.id, {
      status: "IN_PRODUCTION",
      depositDueDate: new Date("2026-08-15"),
      installDate: new Date("2026-09-10"),
    });

    const user = await db.user.create({ data: { name: "Production Lead", email: `pl-${Date.now()}@example.com` } });
    const task = await addTask(project.id, workOrder.id, {
      description: "Fabricate flooring",
      departmentCode: "EF",
      dueDate: new Date("2026-09-01"),
      assignedToId: user.id,
    });
    await updateTaskStatus(project.id, task.id, "IN_PROGRESS");

    const shipment = await addShipment(project.id, workOrder.id, { carrier: "ABC Freight", loadListNote: "2 crates" });
    await updateShipment(project.id, shipment.id, { status: "SHIPPED", trackingRef: "TRK-99" });

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

// Regression tests for the cross-resource ID authorization gap: these
// previously took only a workOrderId/taskId/shipmentId, letting any
// caller with access to SOME project mutate a DIFFERENT (inaccessible)
// project's work orders/tasks/shipments just by supplying its ID -- see
// each function's own header comment in project-service.ts.
describe("project-ownership checks (cross-resource ID authorization)", () => {
  async function makeTwoProjects() {
    const opportunityA = await makeWonOpportunity();
    const opportunityB = await makeWonOpportunity();
    const projectA = await convertOpportunityToProject(opportunityA.id);
    const projectB = await convertOpportunityToProject(opportunityB.id);
    const workOrderA = await startWorkOrder(projectA.id);
    return { projectA, projectB, workOrderA };
  }

  it("updateWorkOrder rejects a workOrderId that belongs to a different project", async () => {
    const { projectB, workOrderA } = await makeTwoProjects();
    await expect(updateWorkOrder(projectB.id, workOrderA.id, { status: "IN_PRODUCTION" })).rejects.toThrow();
  });

  it("addTask rejects a workOrderId that belongs to a different project", async () => {
    const { projectB, workOrderA } = await makeTwoProjects();
    await expect(addTask(projectB.id, workOrderA.id, { description: "Injected" })).rejects.toThrow();
  });

  it("updateTaskStatus / deleteTask reject a taskId that belongs to a different project", async () => {
    const { projectA, projectB, workOrderA } = await makeTwoProjects();
    const task = await addTask(projectA.id, workOrderA.id, { description: "Real task" });

    await expect(updateTaskStatus(projectB.id, task.id, "IN_PROGRESS")).rejects.toThrow();
    await expect(deleteTask(projectB.id, task.id)).rejects.toThrow();

    const stillThere = await db.task.findUnique({ where: { id: task.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.status).toBe("TODO");
  });

  it("addShipment rejects a workOrderId that belongs to a different project", async () => {
    const { projectB, workOrderA } = await makeTwoProjects();
    await expect(addShipment(projectB.id, workOrderA.id, { carrier: "Injected Freight" })).rejects.toThrow();
  });

  it("updateShipment / deleteShipment reject a shipmentId that belongs to a different project", async () => {
    const { projectA, projectB, workOrderA } = await makeTwoProjects();
    const shipment = await addShipment(projectA.id, workOrderA.id, { carrier: "Real Freight" });

    await expect(updateShipment(projectB.id, shipment.id, { status: "SHIPPED" })).rejects.toThrow();
    await expect(deleteShipment(projectB.id, shipment.id)).rejects.toThrow();

    const stillThere = await db.shipment.findUnique({ where: { id: shipment.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.status).toBe("PLANNED");
  });
});

describe("resolveProductionEstimateVersion", () => {
  it("returns null when the opportunity has no locked version yet", async () => {
    const opportunity = await makeWonOpportunity();
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    await createEstimateVersion(estimate.id, 0);

    await expect(resolveProductionEstimateVersion(opportunity.id)).resolves.toBeNull();
  });

  it("returns the highest-versionNumber locked version, across every Estimate the opportunity has", async () => {
    const opportunity = await makeWonOpportunity();
    // Two versions of the SAME estimate (versionNumber is scoped
    // per-estimate, see createEstimateVersion's own previousCurrent
    // lookup) -- both locked (real locking doesn't require the earlier
    // one to be unlocked first, just no longer "current").
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const v1 = await createEstimateVersion(estimate.id);
    await lockEstimateVersion(v1.id);
    const v2 = await createEstimateVersion(estimate.id);
    await lockEstimateVersion(v2.id);

    // A second, unrelated Estimate on the SAME opportunity (e.g. a second
    // exhibit) with its own lower-versionNumber locked version -- confirms
    // the query genuinely spans every Estimate, not just the first found.
    const estimate2 = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const v3 = await createEstimateVersion(estimate2.id);
    await lockEstimateVersion(v3.id);

    const resolved = await resolveProductionEstimateVersion(opportunity.id);
    expect(resolved?.id).toBe(v2.id);
    expect(resolved?.versionNumber).toBe(2);
  });
});

describe("linkLineItemToTask / unlinkLineItemFromTask", () => {
  async function makeProjectWithTaskAndLineItem() {
    const opportunity = await makeWonOpportunity();
    const project = await convertOpportunityToProject(opportunity.id);
    const workOrder = await startWorkOrder(project.id);
    const task = await addTask(project.id, workOrder.id, { description: "Graphics production" });

    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await createEstimateVersion(estimate.id, 0);
    const section = await addSection(version.id, { name: "COMPONENT 1", sectionType: "COMPONENT" });
    const lineItem = await addLineItem(version.id, section.id, {
      lineType: "MATERIAL",
      description: "SEG graphic panel",
      qty: 1,
      unitCost: 500,
    });

    return { opportunity, project, task, lineItem };
  }

  it("links a line item to a task", async () => {
    const { project, task, lineItem } = await makeProjectWithTaskAndLineItem();

    const linked = await linkLineItemToTask(project.id, task.id, lineItem.id);
    expect(linked.taskId).toBe(task.id);
  });

  it("unlinks a line item back to null (unclaimed), not deleted", async () => {
    const { project, task, lineItem } = await makeProjectWithTaskAndLineItem();
    await linkLineItemToTask(project.id, task.id, lineItem.id);

    const unlinked = await unlinkLineItemFromTask(project.id, task.id, lineItem.id);
    expect(unlinked.taskId).toBeNull();

    const stillExists = await db.lineItem.findUnique({ where: { id: lineItem.id } });
    expect(stillExists).not.toBeNull();
  });

  it("re-linking to a different task moves it, rather than requiring an unlink first", async () => {
    const { project, task, lineItem } = await makeProjectWithTaskAndLineItem();
    await linkLineItemToTask(project.id, task.id, lineItem.id);

    const workOrder = await db.workOrder.findFirstOrThrow({ where: { projectId: project.id } });
    const otherTask = await addTask(project.id, workOrder.id, { description: "Structure fabrication" });
    const moved = await linkLineItemToTask(project.id, otherTask.id, lineItem.id);

    expect(moved.taskId).toBe(otherTask.id);
  });

  it("deleting a Task un-assigns its line items rather than deleting or blocking on them", async () => {
    const { project, task, lineItem } = await makeProjectWithTaskAndLineItem();
    await linkLineItemToTask(project.id, task.id, lineItem.id);

    await deleteTask(project.id, task.id);

    const reloaded = await db.lineItem.findUniqueOrThrow({ where: { id: lineItem.id } });
    expect(reloaded.taskId).toBeNull();
  });

  it("rejects linking a lineItemId that belongs to a different project's opportunity", async () => {
    const { project: projectA, task: taskA } = await makeProjectWithTaskAndLineItem();
    const { lineItem: lineItemB } = await makeProjectWithTaskAndLineItem();

    await expect(linkLineItemToTask(projectA.id, taskA.id, lineItemB.id)).rejects.toThrow();
  });

  it("rejects a taskId that belongs to a different project", async () => {
    const { lineItem: lineItemA, project: projectA } = await makeProjectWithTaskAndLineItem();
    const { task: taskB } = await makeProjectWithTaskAndLineItem();

    await expect(linkLineItemToTask(projectA.id, taskB.id, lineItemA.id)).rejects.toThrow();
  });

  it("unlinkLineItemFromTask rejects a lineItemId not currently linked to the given task", async () => {
    const { project, task, lineItem } = await makeProjectWithTaskAndLineItem();
    // Never linked -- lineItem.taskId is still null.
    await expect(unlinkLineItemFromTask(project.id, task.id, lineItem.id)).rejects.toThrow();
  });
});
