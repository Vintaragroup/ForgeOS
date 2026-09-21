import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { confirmActivity, loadSnoozedKeys, logTouch, snoozeQueueItem, unsnoozeQueueItem } from "@/lib/sales-actions";
import { loadSalesOverview } from "@/lib/sales-analytics";
import { TOUCH_SOURCE_LOGGED } from "@/lib/sales-queue";
import { UserError } from "@/lib/user-error";

const NOW = new Date("2026-09-21T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

afterEach(async () => {
  await db.salesQueueSnooze.deleteMany();
  await db.clientTouch.deleteMany();
  await db.salesmateActivity.deleteMany();
  await db.salesmateDeal.deleteMany();
  await db.salesmateCompany.deleteMany();
  await db.contact.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function rep(name: string) {
  return db.user.create({
    data: { name, email: `${name}.${Math.random().toString(36).slice(2)}@expocci.com`, systemRole: "EMPLOYEE" },
  });
}

async function client(name: string, ownerUserId: string, salesmateId: string, lastComm: Date | null) {
  const company = await db.company.create({ data: { name } });
  await db.salesmateCompany.create({
    data: { salesmateId, name, type: "Customer", companyId: company.id, ownerUserId, lastCommunicationAt: lastComm, syncedAt: NOW },
  });
  return company;
}

describe("logTouch", () => {
  it("records a touch credited to the rep, with their note", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));

    await logTouch({ companyId: acme.id, byUserId: terry.id, mode: "Call", note: "  Left a voicemail  " });

    const touch = await db.clientTouch.findFirstOrThrow({ where: { companyId: acme.id } });
    expect(touch).toMatchObject({
      mode: "Call",
      note: "Left a voicemail",
      byUserId: terry.id,
      byName: "Terry",
      source: TOUCH_SOURCE_LOGGED,
    });
  });

  it("falls back to Other for a mode it doesn't know", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", null);
    await logTouch({ companyId: acme.id, byUserId: terry.id, mode: "Carrier pigeon" });
    expect((await db.clientTouch.findFirstOrThrow({ where: { companyId: acme.id } })).mode).toBe("Other");
  });

  it("does not double-count a double submit", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", null);
    const at = new Date("2026-09-21T10:00:00Z");

    await logTouch({ companyId: acme.id, byUserId: terry.id, mode: "Call", occurredAt: at });
    await logTouch({ companyId: acme.id, byUserId: terry.id, mode: "Email", note: "corrected", occurredAt: at });

    const touches = await db.clientTouch.findMany({ where: { companyId: acme.id } });
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ mode: "Email", note: "corrected" });
  });

  it("refuses a touch dated in the future", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", null);
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await expect(logTouch({ companyId: acme.id, byUserId: terry.id, mode: "Call", occurredAt: nextMonth })).rejects.toThrow(UserError);
  });
});

describe("snoozeQueueItem", () => {
  it("hides a going-cold client from the queue and the count, for that rep only", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));
    await db.salesmateDeal.create({
      data: { salesmateId: "100", title: "Won", status: "Won", value: 50_000, companyId: acme.id, ownerUserId: terry.id, closedAt: daysAgo(30), syncedAt: NOW },
    });

    const before = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(before.goingCold.map((c) => c.name)).toEqual(["Acme"]);

    await snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id, days: 14 });

    const after = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(after.goingCold).toHaveLength(0);
    // A manager looking at the whole team still sees it.
    expect((await loadSalesOverview({ ownerUserId: null }, NOW)).goingCold.map((c) => c.name)).toEqual(["Acme"]);
  });

  it("does not reclassify a snoozed client as a quiet prospect", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));
    await db.salesmateDeal.create({
      data: { salesmateId: "100", title: "Won", status: "Won", value: 50_000, companyId: acme.id, ownerUserId: terry.id, closedAt: daysAgo(30), syncedAt: NOW },
    });

    await snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id, days: 14 });
    const after = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(after.quietProspects).toBe(0);
  });

  it("re-snoozing moves the date instead of piling up rows", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));
    await snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id, days: 7 });
    await snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id, days: 30 });

    const rows = await db.salesQueueSnooze.findMany({ where: { userId: terry.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].snoozedUntil.getTime()).toBeGreaterThan(Date.now() + 20 * 24 * 60 * 60 * 1000);
  });

  it("stops hiding the row once the snooze expires", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));
    await snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id, days: 7 });

    const keysNow = await loadSnoozedKeys(terry.id, new Date());
    expect(keysNow.get("FOLLOW_UP")?.has(acme.id)).toBe(true);

    const keysLater = await loadSnoozedKeys(terry.id, new Date(Date.now() + 8 * 24 * 60 * 60 * 1000));
    expect(keysLater.get("FOLLOW_UP")?.has(acme.id) ?? false).toBe(false);
  });

  it("unsnoozing brings it straight back", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));
    await snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id, days: 30 });
    await unsnoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: acme.id });
    expect((await loadSnoozedKeys(terry.id, new Date())).get("FOLLOW_UP")?.has(acme.id) ?? false).toBe(false);
  });

  it("rejects a snooze longer than a year", async () => {
    const terry = await rep("Terry");
    await expect(snoozeQueueItem({ userId: terry.id, queue: "FOLLOW_UP", targetKey: "x", days: 400 })).rejects.toThrow(UserError);
  });
});

describe("confirmActivity", () => {
  async function pastDueActivity(ownerUserId: string, companyId: string | null) {
    return db.salesmateActivity.create({
      data: {
        salesmateId: "a1",
        type: "Call",
        title: "Follow up on the booth quote",
        dueAt: daysAgo(10),
        isCompleted: false,
        companyId,
        ownerUserId,
        syncedAt: NOW,
      },
    });
  }

  it("clears the activity and records it as contact, dated when it was scheduled", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(200));
    await pastDueActivity(terry.id, acme.id);

    await confirmActivity({ salesmateId: "a1", userId: terry.id });

    const activity = await db.salesmateActivity.findUniqueOrThrow({ where: { salesmateId: "a1" } });
    expect(activity.confirmedAt).not.toBeNull();
    expect(activity.confirmedByUserId).toBe(terry.id);

    const touch = await db.clientTouch.findFirstOrThrow({ where: { companyId: acme.id } });
    expect(touch.mode).toBe("Call");
    expect(touch.note).toBe("Follow up on the booth quote");
    // Dated the day it was due, not the day it was ticked off.
    expect(touch.occurredAt.toISOString()).toBe(daysAgo(10).toISOString());

    const { scheduled } = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(scheduled.pastDueCount).toBe(0);
  });

  it("confirms an activity with no client without inventing a touch", async () => {
    const terry = await rep("Terry");
    await pastDueActivity(terry.id, null);
    await confirmActivity({ salesmateId: "a1", userId: terry.id });
    expect(await db.clientTouch.count()).toBe(0);
  });

  it("is idempotent", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", null);
    await pastDueActivity(terry.id, acme.id);

    await confirmActivity({ salesmateId: "a1", userId: terry.id });
    const first = await db.salesmateActivity.findUniqueOrThrow({ where: { salesmateId: "a1" } });
    await confirmActivity({ salesmateId: "a1", userId: terry.id });
    const second = await db.salesmateActivity.findUniqueOrThrow({ where: { salesmateId: "a1" } });

    expect(second.confirmedAt?.toISOString()).toBe(first.confirmedAt?.toISOString());
    expect(await db.clientTouch.count()).toBe(1);
  });
});
