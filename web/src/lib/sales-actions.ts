// The write side of /sales. Everything else in the sales slice reads --
// this is what a rep can actually do from their queues.
//
// Why it exists: before this, every button on the landing page was Open,
// Salesmate or Start intake. A rep worked the Follow-up queue in ForgeOS,
// switched to Salesmate to log the call, and waited for the next sync
// before the row cleared. The queue never responded to their own work, and
// a queue that doesn't clear stops being read.
//
// Three verbs, matching the three things a rep decides about a queue row:
//   logTouch      -- "I contacted them." Clears it and feeds the contact
//                    stat already on the page.
//   snoozeQueueItem -- "Not now." Hides it until a date they choose.
//   confirmActivity -- "Yes, that happened." For past-due scheduled work.
//
// None of it touches Salesmate. The sync is one-way (Salesmate -> ForgeOS)
// and this doesn't change that: a logged touch is a ForgeOS row with
// source LOGGED, sitting alongside the ones the sync infers.

import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { TOUCH_MODES, TOUCH_SOURCE_LOGGED, type TouchMode } from "@/lib/sales-queue";
import type { SalesQueue } from "@/generated/prisma/enums";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SNOOZE_DAYS = 365;

export async function logTouch(input: {
  companyId: string;
  byUserId: string;
  mode: string;
  note?: string | null;
  contactId?: string | null;
  occurredAt?: Date;
}) {
  const mode = TOUCH_MODES.includes(input.mode as TouchMode) ? input.mode : "Other";
  const occurredAt = input.occurredAt ?? new Date();
  if (occurredAt.getTime() > Date.now() + DAY_MS) {
    throw new UserError("That date is in the future -- log a touch after it happens.");
  }

  const company = await db.company.findFirst({ where: { id: input.companyId, deletedAt: null }, select: { id: true } });
  if (!company) throw new UserError("That client no longer exists.");

  const byName = (await db.user.findFirst({ where: { id: input.byUserId }, select: { name: true } }))?.name ?? null;

  // ClientTouch is unique on (companyId, contactId, occurredAt) so a sync
  // re-run can't double-count, and a double-submit shouldn't either. Not
  // an upsert: contactId is nullable, Postgres treats NULLs as distinct in
  // a unique index, and Prisma won't accept null in a compound-unique
  // where. So check first -- the same shape recordTouches uses in
  // salesmate-sync.ts, for the same reason.
  const contactId = input.contactId ?? null;
  const existing = await db.clientTouch.findFirst({
    where: { companyId: input.companyId, contactId, occurredAt },
    select: { id: true },
  });
  const note = input.note?.trim() || null;

  if (existing) {
    return db.clientTouch.update({
      where: { id: existing.id },
      data: { mode, note, byUserId: input.byUserId, byName, source: TOUCH_SOURCE_LOGGED },
    });
  }
  return db.clientTouch.create({
    data: {
      companyId: input.companyId,
      contactId,
      occurredAt,
      mode,
      note,
      byName,
      byUserId: input.byUserId,
      source: TOUCH_SOURCE_LOGGED,
    },
  });
}

export async function snoozeQueueItem(input: {
  userId: string;
  queue: SalesQueue;
  targetKey: string;
  days: number;
  note?: string | null;
}) {
  if (!Number.isFinite(input.days) || input.days < 1) throw new UserError("Pick how long to snooze for.");
  if (input.days > MAX_SNOOZE_DAYS) throw new UserError("A year is the longest you can snooze something.");
  const snoozedUntil = new Date(Date.now() + input.days * DAY_MS);

  return db.salesQueueSnooze.upsert({
    where: { userId_queue_targetKey: { userId: input.userId, queue: input.queue, targetKey: input.targetKey } },
    create: { userId: input.userId, queue: input.queue, targetKey: input.targetKey, snoozedUntil, note: input.note?.trim() || null },
    update: { snoozedUntil, note: input.note?.trim() || null },
  });
}

export async function unsnoozeQueueItem(input: { userId: string; queue: SalesQueue; targetKey: string }) {
  await db.salesQueueSnooze.deleteMany({
    where: { userId: input.userId, queue: input.queue, targetKey: input.targetKey },
  });
}

// "Did this happen?" -- the honest question for a past-due activity, since
// Salesmate's own isCompleted is ticked on roughly 1 activity in 892.
// Confirming also logs a touch when the activity is attached to a client:
// a call that happened IS contact, and making the rep record it twice is
// how you get them to record it never.
export async function confirmActivity(input: { salesmateId: string; userId: string }) {
  const activity = await db.salesmateActivity.findFirst({
    where: { salesmateId: input.salesmateId, removedAt: null },
    select: { salesmateId: true, companyId: true, contactId: true, type: true, title: true, dueAt: true, confirmedAt: true },
  });
  if (!activity) throw new UserError("That scheduled item is no longer in Salesmate.");
  if (activity.confirmedAt) return;

  const confirmedAt = new Date();
  await db.salesmateActivity.update({
    where: { salesmateId: activity.salesmateId },
    data: { confirmedAt, confirmedByUserId: input.userId },
  });

  if (activity.companyId) {
    await logTouch({
      companyId: activity.companyId,
      contactId: activity.contactId,
      byUserId: input.userId,
      mode: touchModeForActivity(activity.type),
      note: activity.title,
      // When it was scheduled for, not when it was ticked off -- a rep
      // confirming Monday's call on Friday contacted them Monday.
      occurredAt: activity.dueAt ?? confirmedAt,
    });
  }
}

// Salesmate's activity types are free text ("Call", "Meeting", "Task",
// "Call Log"...). Anything that isn't recognisably a conversation is
// logged as Other rather than guessed at.
function touchModeForActivity(type: string): TouchMode {
  const t = type.toLowerCase();
  if (t.includes("call")) return "Call";
  if (t.includes("email")) return "Email";
  if (t.includes("meeting") || t.includes("appointment")) return "Meeting";
  if (t.includes("text") || t.includes("sms")) return "Text";
  return "Other";
}

// Which rows this user has hidden, as a set per queue, for the overview to
// filter against. One query for all four queues -- they're read together
// on every page load.
export async function loadSnoozedKeys(userId: string | null, now: Date = new Date()): Promise<Map<SalesQueue, Set<string>>> {
  const byQueue = new Map<SalesQueue, Set<string>>();
  // The team view (userId null) is a manager looking at everyone; one
  // rep's "not now" shouldn't hide a row from their manager's count.
  if (!userId) return byQueue;

  const rows = await db.salesQueueSnooze.findMany({
    where: { userId, snoozedUntil: { gt: now } },
    select: { queue: true, targetKey: true },
  });
  for (const r of rows) {
    let set = byQueue.get(r.queue);
    if (!set) byQueue.set(r.queue, (set = new Set()));
    set.add(r.targetKey);
  }
  return byQueue;
}
