// Intake: a sales rep gathers everything about a job, then submits it for
// the client review meeting, where sales management schedules the meeting
// and assigns a designer and an estimator.
//
// The completeness rules live here rather than in the form, for the same
// reason every other gate in this app does: a Server Action is reachable
// on its own, and "the button was disabled" is not a check. The form reads
// the same list to show what's still missing, so the two can't disagree.
//
// Required set agreed with the user (2026-09-20): client + contact + show
// + event dates, booth details, the logistics dates, and at least one
// meeting note -- "what the client actually asked for" is the point of the
// review meeting, so submitting without it is meaningless.

import type { Opportunity } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";

export const DESIGNER_DEPARTMENT = "DE";
export const ESTIMATOR_DEPARTMENT = "ES";

export interface IntakeRequirement {
  key: string;
  label: string;
  // Which section of the intake page it lives in, so "what's missing" can
  // point somewhere.
  section: "client" | "show" | "booth" | "logistics" | "notes";
  met: boolean;
}

export interface IntakeStatus {
  requirements: IntakeRequirement[];
  missing: IntakeRequirement[];
  complete: boolean;
  submittedAt: Date | null;
  reviewMeetingAt: Date | null;
  reviewCompletedAt: Date | null;
  designerId: string | null;
  estimatorId: string | null;
}

type IntakeOpportunity = Pick<
  Opportunity,
  | "companyId" | "primaryContactId" | "showName" | "eventStartDate" | "eventEndDate"
  | "boothNumber" | "boothSize" | "boothSpace" | "boothType"
  | "targetMoveIn" | "targetMoveOut" | "shipDate"
  | "intakeSubmittedAt" | "reviewMeetingAt" | "reviewCompletedAt" | "designerId" | "estimatorId"
>;

export function intakeRequirements(opportunity: IntakeOpportunity, meetingNoteCount: number): IntakeRequirement[] {
  return [
    { key: "company", label: "Client company", section: "client", met: Boolean(opportunity.companyId) },
    { key: "contact", label: "Primary client contact", section: "client", met: Boolean(opportunity.primaryContactId) },
    { key: "show", label: "Show name", section: "show", met: Boolean(opportunity.showName?.trim()) },
    {
      key: "eventDates",
      label: "Event start and end dates",
      section: "show",
      met: Boolean(opportunity.eventStartDate && opportunity.eventEndDate),
    },
    { key: "boothNumber", label: "Booth number", section: "booth", met: Boolean(opportunity.boothNumber?.trim()) },
    { key: "boothSize", label: "Booth size", section: "booth", met: Boolean(opportunity.boothSize?.trim()) },
    { key: "boothSpace", label: "Booth space (inline, island, ...)", section: "booth", met: Boolean(opportunity.boothSpace) },
    { key: "boothType", label: "Booth type", section: "booth", met: Boolean(opportunity.boothType) },
    { key: "moveIn", label: "Target move-in", section: "logistics", met: Boolean(opportunity.targetMoveIn) },
    { key: "moveOut", label: "Target move-out", section: "logistics", met: Boolean(opportunity.targetMoveOut) },
    { key: "shipDate", label: "Ship date", section: "logistics", met: Boolean(opportunity.shipDate) },
    {
      key: "meetingNote",
      label: "At least one client meeting or call note",
      section: "notes",
      met: meetingNoteCount > 0,
    },
  ];
}

export async function loadIntakeStatus(opportunityId: string): Promise<IntakeStatus> {
  const [opportunity, meetingNoteCount] = await Promise.all([
    db.opportunity.findUniqueOrThrow({
      where: { id: opportunityId },
      select: {
        companyId: true, primaryContactId: true, showName: true, eventStartDate: true, eventEndDate: true,
        boothNumber: true, boothSize: true, boothSpace: true, boothType: true,
        targetMoveIn: true, targetMoveOut: true, shipDate: true,
        intakeSubmittedAt: true, reviewMeetingAt: true, reviewCompletedAt: true, designerId: true, estimatorId: true,
      },
    }),
    db.opportunityNote.count({
      where: { opportunityId, deletedAt: null, kind: { in: ["CLIENT_MEETING", "CLIENT_CALL"] } },
    }),
  ]);
  const requirements = intakeRequirements(opportunity, meetingNoteCount);
  const missing = requirements.filter((r) => !r.met);
  return {
    requirements,
    missing,
    complete: missing.length === 0,
    submittedAt: opportunity.intakeSubmittedAt,
    reviewMeetingAt: opportunity.reviewMeetingAt,
    reviewCompletedAt: opportunity.reviewCompletedAt,
    designerId: opportunity.designerId,
    estimatorId: opportunity.estimatorId,
  };
}

// Who the request goes to: sales managers (admins are included -- they can
// already see and do everything, and on this account both sales managers
// happen to be admins anyway).
export async function reviewRecipients() {
  return db.user.findMany({
    where: { deletedAt: null, OR: [{ isSalesManager: true }, { systemRole: { in: ["ADMIN", "SUPER_ADMIN"] } }] },
    select: { id: true, name: true, email: true },
    orderBy: { name: "asc" },
  });
}

export async function submitForClientReview(opportunityId: string, submittedByUserId: string) {
  const status = await loadIntakeStatus(opportunityId);
  if (status.submittedAt) throw new UserError("This opportunity has already been submitted for client review.");
  if (!status.complete) {
    throw new UserError(
      `Still missing: ${status.missing.map((m) => m.label.toLowerCase()).join(", ")}. Fill these in before submitting.`,
    );
  }
  return db.opportunity.update({
    where: { id: opportunityId },
    data: { intakeSubmittedAt: new Date(), intakeSubmittedByUserId: submittedByUserId },
  });
}

// Sales management schedules the meeting. Reopening (clearing the date) is
// deliberately allowed -- meetings move.
export async function scheduleClientReview(opportunityId: string, meetingAt: Date | null) {
  const opportunity = await db.opportunity.findUniqueOrThrow({
    where: { id: opportunityId },
    select: { intakeSubmittedAt: true },
  });
  if (!opportunity.intakeSubmittedAt) throw new UserError("This opportunity hasn't been submitted for review yet.");
  return db.opportunity.update({ where: { id: opportunityId }, data: { reviewMeetingAt: meetingAt } });
}

export async function completeClientReview(opportunityId: string) {
  const status = await loadIntakeStatus(opportunityId);
  if (!status.submittedAt) throw new UserError("This opportunity hasn't been submitted for review yet.");
  if (!status.designerId || !status.estimatorId) {
    throw new UserError("Assign both a designer and an estimator before closing out the review.");
  }
  return db.opportunity.update({ where: { id: opportunityId }, data: { reviewCompletedAt: new Date() } });
}

// Designer/estimator come from the Design and Estimating departments --
// checked here, not just filtered in the picker, since the action is
// reachable on its own. Either can be cleared by passing null.
export async function assignReviewTeam(
  opportunityId: string,
  input: { designerId?: string | null; estimatorId?: string | null },
) {
  const data: { designerId?: string | null; estimatorId?: string | null } = {};
  if (input.designerId !== undefined) {
    data.designerId = await validateDepartmentMember(input.designerId, DESIGNER_DEPARTMENT, "designer");
  }
  if (input.estimatorId !== undefined) {
    data.estimatorId = await validateDepartmentMember(input.estimatorId, ESTIMATOR_DEPARTMENT, "estimator");
  }
  if (Object.keys(data).length === 0) return;
  await db.opportunity.update({ where: { id: opportunityId }, data });
}

async function validateDepartmentMember(userId: string | null, departmentCode: string, role: string) {
  if (!userId) return null;
  const user = await db.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { departmentCode: true, systemRole: true },
  });
  if (!user) throw new UserError(`That ${role} no longer exists.`);
  const isAdmin = user.systemRole === "ADMIN" || user.systemRole === "SUPER_ADMIN";
  if (user.departmentCode !== departmentCode && !isAdmin) {
    throw new UserError(
      `A ${role} must be in the ${departmentCode === DESIGNER_DEPARTMENT ? "Design" : "Estimating"} department. ` +
        "Assign them to it in Admin -> Users first.",
    );
  }
  return userId;
}

export async function assignableUsers() {
  const [designers, estimators] = await Promise.all([
    db.user.findMany({ where: { deletedAt: null, departmentCode: DESIGNER_DEPARTMENT }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.user.findMany({ where: { deletedAt: null, departmentCode: ESTIMATOR_DEPARTMENT }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);
  return { designers, estimators };
}

// The queue sales management works: submitted, not yet reviewed. Oldest
// first -- a rep waiting on a meeting is blocked.
export async function pendingClientReviews() {
  return db.opportunity.findMany({
    where: { deletedAt: null, intakeSubmittedAt: { not: null }, reviewCompletedAt: null },
    select: {
      id: true, showName: true, boothSize: true, eventStartDate: true,
      intakeSubmittedAt: true, reviewMeetingAt: true, designerId: true, estimatorId: true,
      company: { select: { id: true, name: true } },
      intakeSubmittedBy: { select: { name: true } },
    },
    orderBy: { intakeSubmittedAt: "asc" },
  });
}
