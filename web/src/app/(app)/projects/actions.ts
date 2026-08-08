"use server";

import {
  addShipment,
  addTask,
  deleteShipment,
  deleteTask,
  startWorkOrder,
  updateProjectDetails,
  updateShipment,
  updateTaskStatus,
  updateWorkOrder,
} from "@/lib/project-service";
import type { ProjectStatus, ShipmentStatus, TaskStatus, WorkOrderStatus } from "@/generated/prisma/enums";
import { revalidatePath } from "next/cache";

export async function updateProjectDetailsAction(projectId: string, formData: FormData) {
  const jobNumber = emptyToNull(formData.get("jobNumber"));
  const status = String(formData.get("status")) as ProjectStatus;
  const showStartDate = emptyToDate(formData.get("showStartDate"));
  const showEndDate = emptyToDate(formData.get("showEndDate"));

  await updateProjectDetails(projectId, { jobNumber, status, showStartDate, showEndDate });
  revalidatePath(`/projects/${projectId}`);
}

export async function startWorkOrderAction(projectId: string) {
  await startWorkOrder(projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function updateWorkOrderAction(projectId: string, workOrderId: string, formData: FormData) {
  const status = String(formData.get("status")) as WorkOrderStatus;
  const depositDueDate = emptyToDate(formData.get("depositDueDate"));
  const productionMeetingDate = emptyToDate(formData.get("productionMeetingDate"));
  const artworkDeadlineDate = emptyToDate(formData.get("artworkDeadlineDate"));
  const balanceDueDate = emptyToDate(formData.get("balanceDueDate"));
  const installDate = emptyToDate(formData.get("installDate"));

  await updateWorkOrder(workOrderId, {
    status,
    depositDueDate,
    productionMeetingDate,
    artworkDeadlineDate,
    balanceDueDate,
    installDate,
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function addTaskAction(projectId: string, workOrderId: string, formData: FormData) {
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Task description is required");
  const departmentCode = emptyToNull(formData.get("departmentCode"));
  const dueDate = emptyToDate(formData.get("dueDate"));
  const assignedToId = emptyToNull(formData.get("assignedToId"));
  const vendorId = emptyToNull(formData.get("vendorId"));

  await addTask(workOrderId, { description, departmentCode, dueDate, assignedToId, vendorId });
  revalidatePath(`/projects/${projectId}`);
}

export async function updateTaskStatusAction(projectId: string, taskId: string, formData: FormData) {
  const status = String(formData.get("status")) as TaskStatus;
  await updateTaskStatus(taskId, status);
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteTaskAction(projectId: string, taskId: string) {
  await deleteTask(taskId);
  revalidatePath(`/projects/${projectId}`);
}

export async function addShipmentAction(projectId: string, workOrderId: string, formData: FormData) {
  const carrier = emptyToNull(formData.get("carrier"));
  const loadListNote = emptyToNull(formData.get("loadListNote"));
  const shipDate = emptyToDate(formData.get("shipDate"));

  await addShipment(workOrderId, { carrier, loadListNote, shipDate });
  revalidatePath(`/projects/${projectId}`);
}

export async function updateShipmentAction(projectId: string, shipmentId: string, formData: FormData) {
  const status = String(formData.get("status")) as ShipmentStatus;
  const trackingRef = emptyToNull(formData.get("trackingRef"));

  await updateShipment(shipmentId, { status, trackingRef });
  revalidatePath(`/projects/${projectId}`);
}

export async function deleteShipmentAction(projectId: string, shipmentId: string) {
  await deleteShipment(shipmentId);
  revalidatePath(`/projects/${projectId}`);
}

function emptyToNull(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function emptyToDate(value: FormDataEntryValue | null): Date | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : new Date(str);
}
