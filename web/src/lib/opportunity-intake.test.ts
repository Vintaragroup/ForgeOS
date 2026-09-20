import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  assignReviewTeam,
  completeClientReview,
  loadIntakeStatus,
  pendingClientReviews,
  scheduleClientReview,
  submitForClientReview,
} from "@/lib/opportunity-intake";
import { UserError } from "@/lib/user-error";

afterEach(async () => {
  await db.opportunityNote.deleteMany();
  await db.opportunityShowDeadline.deleteMany();
  await db.opportunity.deleteMany();
  await db.contact.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function user(name: string, extra: { departmentCode?: string; systemRole?: "EMPLOYEE" | "ADMIN" } = {}) {
  return db.user.create({
    data: { name, email: `${name.replace(/\W/g, "")}.${Math.random().toString(36).slice(2)}@expocci.com`, systemRole: extra.systemRole ?? "EMPLOYEE", departmentCode: extra.departmentCode },
  });
}

// Everything the agreed required set asks for, so tests can remove one
// thing at a time and see exactly that thing reported.
async function completeOpportunity() {
  const company = await db.company.create({ data: { name: "Club Glove" } });
  const contact = await db.contact.create({ data: { name: "Dana", role: "CLIENT_CONTACT", companyId: company.id } });
  const opportunity = await db.opportunity.create({
    data: {
      companyId: company.id,
      primaryContactId: contact.id,
      showName: "PGA Show 2027",
      eventStartDate: new Date("2027-01-20"),
      eventEndDate: new Date("2027-01-23"),
      boothNumber: "2411",
      boothSize: "20x20",
      boothSpace: "ISLAND",
      boothType: "RENTAL",
      targetMoveIn: new Date("2027-01-17"),
      targetMoveOut: new Date("2027-01-24"),
      shipDate: new Date("2027-01-10"),
    },
  });
  await db.opportunityNote.create({
    data: { opportunityId: opportunity.id, kind: "CLIENT_MEETING", body: "Client wants a bar and two demo bays.", occurredAt: new Date("2026-09-18") },
  });
  return opportunity;
}

describe("intake completeness", () => {
  it("reports every missing requirement by name, and only blocks on those", async () => {
    const opportunity = await completeOpportunity();
    expect((await loadIntakeStatus(opportunity.id)).complete).toBe(true);

    await db.opportunity.update({ where: { id: opportunity.id }, data: { boothNumber: null, shipDate: null, primaryContactId: null } });
    const status = await loadIntakeStatus(opportunity.id);
    expect(status.complete).toBe(false);
    expect(status.missing.map((m) => m.key).sort()).toEqual(["boothNumber", "contact", "shipDate"]);
    // Sections drive where the form points the rep.
    expect(status.missing.find((m) => m.key === "boothNumber")?.section).toBe("booth");
  });

  it("counts only client meeting/call notes -- an internal note isn't the client's brief", async () => {
    const opportunity = await completeOpportunity();
    await db.opportunityNote.deleteMany({ where: { opportunityId: opportunity.id } });
    await db.opportunityNote.create({
      data: { opportunityId: opportunity.id, kind: "INTERNAL", body: "Check rigging rules", occurredAt: new Date() },
    });

    const status = await loadIntakeStatus(opportunity.id);
    expect(status.missing.map((m) => m.key)).toEqual(["meetingNote"]);
  });
});

describe("submit / schedule / assign / complete", () => {
  it("refuses an incomplete submission, naming what's missing", async () => {
    const rep = await user("Terry");
    const opportunity = await completeOpportunity();
    await db.opportunity.update({ where: { id: opportunity.id }, data: { targetMoveOut: null } });

    await expect(submitForClientReview(opportunity.id, rep.id)).rejects.toThrow(/target move-out/i);
    await expect(submitForClientReview(opportunity.id, rep.id)).rejects.toBeInstanceOf(UserError);
    expect((await loadIntakeStatus(opportunity.id)).submittedAt).toBeNull();
  });

  it("runs the whole path: submit, schedule, assign both, complete", async () => {
    const rep = await user("Terry");
    const designer = await user("Dee", { departmentCode: "DE" });
    const estimator = await user("Esther", { departmentCode: "ES" });
    const opportunity = await completeOpportunity();

    await submitForClientReview(opportunity.id, rep.id);
    const submitted = await loadIntakeStatus(opportunity.id);
    expect(submitted.submittedAt).not.toBeNull();
    await expect(submitForClientReview(opportunity.id, rep.id)).rejects.toThrow(/already been submitted/);

    // It's in the queue sales management works, before a meeting is set.
    expect((await pendingClientReviews()).map((o) => o.id)).toContain(opportunity.id);

    await scheduleClientReview(opportunity.id, new Date("2026-09-25T15:00:00Z"));
    await expect(completeClientReview(opportunity.id)).rejects.toThrow(/designer and an estimator/);

    await assignReviewTeam(opportunity.id, { designerId: designer.id, estimatorId: estimator.id });
    await completeClientReview(opportunity.id);

    const done = await loadIntakeStatus(opportunity.id);
    expect(done.reviewMeetingAt?.toISOString()).toBe("2026-09-25T15:00:00.000Z");
    expect(done).toMatchObject({ designerId: designer.id, estimatorId: estimator.id });
    expect(done.reviewCompletedAt).not.toBeNull();
    // Closed out -- off the queue.
    expect((await pendingClientReviews()).map((o) => o.id)).not.toContain(opportunity.id);
  });

  it("won't schedule before submission, and won't take a designer from the wrong department", async () => {
    const rep = await user("Terry");
    const notADesigner = await user("Warehouse Wendy", { departmentCode: "WH" });
    const admin = await user("Admin Ann", { systemRole: "ADMIN" });
    const opportunity = await completeOpportunity();

    await expect(scheduleClientReview(opportunity.id, new Date())).rejects.toThrow(/hasn't been submitted/);
    await submitForClientReview(opportunity.id, rep.id);
    await expect(assignReviewTeam(opportunity.id, { designerId: notADesigner.id })).rejects.toThrow(/Design department/);

    // An admin can be assigned to either role without a department.
    await assignReviewTeam(opportunity.id, { designerId: admin.id });
    expect((await loadIntakeStatus(opportunity.id)).designerId).toBe(admin.id);
    // Clearing is allowed.
    await assignReviewTeam(opportunity.id, { designerId: null });
    expect((await loadIntakeStatus(opportunity.id)).designerId).toBeNull();
  });
});
