"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { requireOpportunityAccess } from "@/lib/opportunity-access";
import { canViewWholeTeam } from "@/lib/sales-analytics";
import {
  assignReviewTeam,
  completeClientReview,
  scheduleClientReview,
  submitForClientReview,
} from "@/lib/opportunity-intake";
import { db } from "@/lib/db";
import { catchUserError, UserError, type ActionResult } from "@/lib/user-error";
import type { BoothSpace, BoothType, OpportunityNoteKind } from "@/generated/prisma/enums";

// Intake is the rep's own gathering step, so everything here is gated by
// opportunity access -- except scheduling and assigning, which belong to
// sales management (agreed 2026-09-20) and re-check that separately.

const NOTE_KINDS: OpportunityNoteKind[] = ["CLIENT_MEETING", "CLIENT_CALL", "INTERNAL", "SITE_VISIT", "OTHER"];

function revalidate(id: string) {
  revalidatePath(`/opportunities/${id}/intake`);
  revalidatePath(`/opportunities/${id}`);
  revalidatePath("/sales");
}

export async function saveIntakeDetailsAction(id: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireOpportunityAccess(id);
  const result = await catchUserError(async () => {
    const showName = String(formData.get("showName") ?? "").trim();
    if (!showName) throw new UserError("Show name is required.");
    await db.opportunity.update({
      where: { id },
      data: {
        showName,
        primaryContactId: text(formData.get("primaryContactId")),
        venue: text(formData.get("venue")),
        eventStartDate: date(formData.get("eventStartDate"), "Event start"),
        eventEndDate: date(formData.get("eventEndDate"), "Event end"),
        boothNumber: text(formData.get("boothNumber")),
        boothSize: text(formData.get("boothSize")),
        boothSpace: enumOrNull<BoothSpace>(formData.get("boothSpace"), ["ISLAND", "PENINSULA", "IN_LINE", "PERIMETER"]),
        boothType: enumOrNull<BoothType>(formData.get("boothType"), ["RENTAL", "PURCHASE", "CLIENT_OWNED"]),
        targetMoveIn: date(formData.get("targetMoveIn"), "Target move-in"),
        targetMoveOut: date(formData.get("targetMoveOut"), "Target move-out"),
        shipDate: date(formData.get("shipDate"), "Ship date"),
        siteAddress: text(formData.get("siteAddress")),
        projectDetails: text(formData.get("projectDetails")),
        showContactName: text(formData.get("showContactName")),
        showContactEmail: text(formData.get("showContactEmail")),
        showContactPhone: text(formData.get("showContactPhone")),
        exhibitorKitUrl: text(formData.get("exhibitorKitUrl")),
        exhibitorAccountRef: text(formData.get("exhibitorAccountRef")),
        hall: text(formData.get("hall")),
        hallDetail: text(formData.get("hallDetail")),
      },
    });
  });
  if (!result) revalidate(id);
  return result;
}

export async function addIntakeNoteAction(id: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const user = await requireOpportunityAccess(id);
  const result = await catchUserError(async () => {
    const body = String(formData.get("body") ?? "").trim();
    if (!body) throw new UserError("Write what was said before saving the note.");
    const rawKind = String(formData.get("kind") ?? "");
    const kind = NOTE_KINDS.includes(rawKind as OpportunityNoteKind) ? (rawKind as OpportunityNoteKind) : "INTERNAL";
    await db.opportunityNote.create({
      data: {
        opportunityId: id,
        kind,
        body,
        // When the conversation happened, not when it was typed up.
        occurredAt: date(formData.get("occurredAt"), "Date") ?? new Date(),
        departmentCode: text(formData.get("departmentCode")),
        authorUserId: user.id,
      },
    });
  });
  if (!result) revalidate(id);
  return result;
}

export async function deleteIntakeNoteAction(id: string, noteId: string) {
  await requireOpportunityAccess(id);
  // Scoped by opportunity so a note id from a form can't delete another
  // opportunity's note.
  await db.opportunityNote.updateMany({ where: { id: noteId, opportunityId: id }, data: { deletedAt: new Date() } });
  revalidate(id);
}

export async function addShowDeadlineAction(id: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  await requireOpportunityAccess(id);
  const result = await catchUserError(async () => {
    const label = String(formData.get("label") ?? "").trim();
    const dueDate = date(formData.get("dueDate"), "Due date");
    if (!label) throw new UserError("Name the deadline (electrical, rigging, discount cut-off…).");
    if (!dueDate) throw new UserError("Give the deadline a date.");
    await db.opportunityShowDeadline.create({
      data: { opportunityId: id, label, dueDate, note: text(formData.get("note")) },
    });
  });
  if (!result) revalidate(id);
  return result;
}

export async function deleteShowDeadlineAction(id: string, deadlineId: string) {
  await requireOpportunityAccess(id);
  await db.opportunityShowDeadline.updateMany({ where: { id: deadlineId, opportunityId: id }, data: { deletedAt: new Date() } });
  revalidate(id);
}

export async function submitForReviewAction(id: string): Promise<ActionResult> {
  const user = await requireOpportunityAccess(id);
  const result = await catchUserError(() => submitForClientReview(id, user.id));
  if (!result) revalidate(id);
  return result;
}

// --- sales management only ---------------------------------------------

async function requireSalesManager() {
  const user = await getCurrentUser();
  if (!user) throw new Error("Not authenticated");
  if (!canViewWholeTeam(user)) {
    throw new UserError("Only sales managers can schedule the review meeting and assign the team.");
  }
  return user;
}

export async function scheduleReviewAction(id: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    await requireSalesManager();
    await scheduleClientReview(id, date(formData.get("reviewMeetingAt"), "Meeting date/time"));
  });
  if (!result) revalidate(id);
  return result;
}

export async function assignTeamAction(id: string, _prev: ActionResult, formData: FormData): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    await requireSalesManager();
    await assignReviewTeam(id, {
      designerId: text(formData.get("designerId")),
      estimatorId: text(formData.get("estimatorId")),
    });
  });
  if (!result) revalidate(id);
  return result;
}

export async function completeReviewAction(id: string): Promise<ActionResult> {
  const result = await catchUserError(async () => {
    await requireSalesManager();
    await completeClientReview(id);
  });
  if (!result) revalidate(id);
  return result;
}

function text(value: FormDataEntryValue | null): string | null {
  const str = String(value ?? "").trim();
  return str === "" ? null : str;
}

function date(value: FormDataEntryValue | null, label: string): Date | null {
  const str = String(value ?? "").trim();
  if (!str) return null;
  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) throw new UserError(`${label} isn't a date I understand.`);
  return parsed;
}

function enumOrNull<T extends string>(value: FormDataEntryValue | null, allowed: T[]): T | null {
  const str = String(value ?? "").trim();
  return allowed.includes(str as T) ? (str as T) : null;
}
