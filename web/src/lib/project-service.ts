// Framework-agnostic project/work-order logic, kept separate from Server
// Action wrappers the same way opportunity-service.ts and
// estimate-service.ts are (see opportunity-service.ts's header comment).

import { db } from "@/lib/db";
import type { ProjectStatus, ShipmentStatus, TaskStatus, WorkOrderStatus } from "@/generated/prisma/enums";
import type { DocumentSummary } from "@/lib/ai/document-summary-service";
import { parseFreeTextDate } from "@/lib/citation";

// docs/migration-plan.md Phase 5: "Convert to Project" from a WON
// Opportunity -- mirrors Phase 2's "Convert to estimate." No stage
// transition here (unlike convertOpportunityToEstimate): the opportunity
// is already at its terminal WON stage by the time this runs.
//
// showStartDate/showEndDate inherit from the opportunity's own
// eventStartDate/eventEndDate (set during onboarding, manually or via an
// accepted AI suggestion) rather than starting blank -- same inheritance
// principle as Estimate.taxRateId defaulting from the opportunity in
// opportunity-service.ts. Still editable afterward on the Project page.
export async function convertOpportunityToProject(opportunityId: string) {
  const opportunity = await db.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
  return db.project.create({
    data: {
      opportunityId,
      showStartDate: opportunity.eventStartDate,
      showEndDate: opportunity.eventEndDate,
    },
  });
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
// workflow evidence. installDate alone gets a best-effort prefill from
// the RFP's own extracted key dates (see findInstallDateFromDocuments) --
// deposit/production-meeting/artwork/balance dates are the shop's own
// internal production schedule, not something an RFP states, so there's
// no honest source to prefill those from.
export async function startWorkOrder(projectId: string) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const installDate = await findInstallDateFromDocuments(project.opportunityId);
  return db.workOrder.create({ data: { projectId, installDate } });
}

// Looks for a key date whose label is about installation STARTING, not a
// sub-wave or the completion milestone -- "Start of Installation" should
// win over "Wave 1 Installation" or "Installation Complete" when a
// document has all three, since the earliest one is what a production
// schedule actually needs. Read-only regex match on the label text (no
// AI call here), taking the earliest of any documents that qualify.
async function findInstallDateFromDocuments(opportunityId: string): Promise<Date | null> {
  const documents = await db.document.findMany({
    where: { opportunityId, deletedAt: null, extractionStatus: "COMPLETE" },
    select: { extractedSummary: true },
  });

  const candidates: Date[] = [];
  for (const document of documents) {
    if (!document.extractedSummary) continue;
    const summary = document.extractedSummary as unknown as DocumentSummary;
    for (const keyDate of summary.keyDates) {
      if (!/\binstall/i.test(keyDate.label) || /complete|wave/i.test(keyDate.label)) continue;
      const date = parseFreeTextDate(keyDate.date);
      if (date) candidates.push(date);
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}

// projectId is the caller's already-access-checked project (from
// requireProjectAccess), NOT trusted from workOrderId alone -- a
// workOrderId taken from a form/URL directly doesn't prove it belongs to
// the project the caller was actually authorized for, the same cross-
// resource ID gap estimate-service.ts's deleteLineItem (and friends) were
// fixed for. findFirstOrThrow with both id AND projectId in the where
// clause does the ownership check and the existence check in one query.
export async function updateWorkOrder(
  projectId: string,
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
  const existing = await db.workOrder.findFirstOrThrow({ where: { id: workOrderId, projectId } });
  return db.workOrder.update({ where: { id: existing.id }, data });
}

// task_type maps to business-rules.md Rule 1's department codes or Rule
// 3's five special slots (DESIGN TIME, ENGINEERING, ESTIMATING, PRESET,
// PACKING) -- free text, not a rigid enum, per schema.prisma's Task
// comment. Gives production staff an actual worklist, which the workbook
// never provided (it only priced these activities, never assigned/
// tracked them).
// projectId ownership check -- see updateWorkOrder's header comment.
export async function addTask(
  projectId: string,
  workOrderId: string,
  data: {
    description: string;
    departmentCode?: string | null;
    dueDate?: Date | null;
    assignedToId?: string | null;
    vendorId?: string | null;
  },
) {
  const workOrder = await db.workOrder.findFirstOrThrow({ where: { id: workOrderId, projectId } });
  return db.task.create({ data: { workOrderId: workOrder.id, ...data } });
}

// projectId ownership check -- see updateWorkOrder's header comment. Task
// is one hop further from Project than WorkOrder (Task -> WorkOrder ->
// Project), so this goes through the relation rather than a direct
// projectId column.
export async function updateTaskStatus(projectId: string, taskId: string, status: TaskStatus) {
  const existing = await db.task.findFirstOrThrow({ where: { id: taskId, workOrder: { projectId } } });
  return db.task.update({ where: { id: existing.id }, data: { status } });
}

export async function deleteTask(projectId: string, taskId: string) {
  const existing = await db.task.findFirstOrThrow({ where: { id: taskId, workOrder: { projectId } } });
  return db.task.delete({ where: { id: existing.id } });
}

// Self-contained ForgeOS record replacing the workbook's TRUCKING & LOAD
// LIST sheet, whose own data depends on a broken external link
// (schema.prisma's Shipment comment).
// projectId ownership check -- see updateWorkOrder's header comment.
export async function addShipment(
  projectId: string,
  workOrderId: string,
  data: { carrier?: string | null; loadListNote?: string | null; shipDate?: Date | null; trackingRef?: string | null },
) {
  const workOrder = await db.workOrder.findFirstOrThrow({ where: { id: workOrderId, projectId } });
  return db.shipment.create({ data: { workOrderId: workOrder.id, ...data } });
}

// projectId ownership check -- see updateTaskStatus's header comment
// (same one-hop-further-than-WorkOrder relation shape).
export async function updateShipment(
  projectId: string,
  shipmentId: string,
  data: {
    carrier?: string | null;
    loadListNote?: string | null;
    shipDate?: Date | null;
    trackingRef?: string | null;
    status?: ShipmentStatus;
  },
) {
  const existing = await db.shipment.findFirstOrThrow({ where: { id: shipmentId, workOrder: { projectId } } });
  return db.shipment.update({ where: { id: existing.id }, data });
}

export async function deleteShipment(projectId: string, shipmentId: string) {
  const existing = await db.shipment.findFirstOrThrow({ where: { id: shipmentId, workOrder: { projectId } } });
  return db.shipment.delete({ where: { id: existing.id } });
}
