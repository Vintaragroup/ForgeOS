// Framework-agnostic project/work-order logic, kept separate from Server
// Action wrappers the same way opportunity-service.ts and
// estimate-service.ts are (see opportunity-service.ts's header comment).

import { db } from "@/lib/db";
import type { ProjectStatus, ShipmentStatus, TaskStatus, WorkOrderStatus } from "@/generated/prisma/enums";

// docs/migration-plan.md Phase 5: "Convert to Project" from a WON
// Opportunity -- mirrors Phase 2's "Convert to estimate." No stage
// transition here (unlike convertOpportunityToEstimate): the opportunity
// is already at its terminal WON stage by the time this runs.
export async function convertOpportunityToProject(opportunityId: string) {
  return db.project.create({ data: { opportunityId } });
}

export async function updateProjectDetails(
  projectId: string,
  data: { jobNumber?: string | null; status?: ProjectStatus; showStartDate?: Date | null; showEndDate?: Date | null },
) {
  return db.project.update({ where: { id: projectId }, data });
}

// A WorkOrder's timeline milestones (deposit -> production meeting ->
// artwork deadline -> balance due -> install) start as trackable dates,
// not the workbook's static text -- docs/workflow-map.md's clearest
// workflow evidence.
export async function startWorkOrder(projectId: string) {
  return db.workOrder.create({ data: { projectId } });
}

export async function updateWorkOrder(
  workOrderId: string,
  data: {
    status?: WorkOrderStatus;
    depositDueDate?: Date | null;
    productionMeetingDate?: Date | null;
    artworkDeadlineDate?: Date | null;
    balanceDueDate?: Date | null;
    installDate?: Date | null;
  },
) {
  return db.workOrder.update({ where: { id: workOrderId }, data });
}

// task_type maps to business-rules.md Rule 1's department codes or Rule
// 3's five special slots (DESIGN TIME, ENGINEERING, ESTIMATING, PRESET,
// PACKING) -- free text, not a rigid enum, per schema.prisma's Task
// comment. Gives production staff an actual worklist, which the workbook
// never provided (it only priced these activities, never assigned/
// tracked them).
export async function addTask(
  workOrderId: string,
  data: {
    description: string;
    departmentCode?: string | null;
    dueDate?: Date | null;
    assignedToId?: string | null;
    vendorId?: string | null;
  },
) {
  return db.task.create({ data: { workOrderId, ...data } });
}

export async function updateTaskStatus(taskId: string, status: TaskStatus) {
  return db.task.update({ where: { id: taskId }, data: { status } });
}

export async function deleteTask(taskId: string) {
  return db.task.delete({ where: { id: taskId } });
}

// Self-contained ForgeOS record replacing the workbook's TRUCKING & LOAD
// LIST sheet, whose own data depends on a broken external link
// (schema.prisma's Shipment comment).
export async function addShipment(
  workOrderId: string,
  data: { carrier?: string | null; loadListNote?: string | null; shipDate?: Date | null; trackingRef?: string | null },
) {
  return db.shipment.create({ data: { workOrderId, ...data } });
}

export async function updateShipment(
  shipmentId: string,
  data: {
    carrier?: string | null;
    loadListNote?: string | null;
    shipDate?: Date | null;
    trackingRef?: string | null;
    status?: ShipmentStatus;
  },
) {
  return db.shipment.update({ where: { id: shipmentId }, data });
}

export async function deleteShipment(shipmentId: string) {
  return db.shipment.delete({ where: { id: shipmentId } });
}
