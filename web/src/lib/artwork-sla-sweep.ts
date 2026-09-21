// The artwork pipeline's first active-notification job -- kept in its own
// file for the same reason artwork-notifications.ts stays separate from
// artwork-order-service.ts: this is a periodic sweep over many orders, not
// a single-order state transition, and it composes the other two files
// (reads state, sends a notification, writes state back) rather than
// belonging to either one.
import { db } from "@/lib/db";
import { ACTIVE_ARTWORK_ORDER } from "@/lib/artwork-scope";
import { notifySlaWarning } from "@/lib/artwork-notifications";

export interface SlaWarningSweepResult {
  notified: number;
}

// Warns once an order is past the HALFWAY point between when it entered
// EXPO_PROOF_CHECK and its slaDueAt -- not simply "close to slaDueAt,"
// since slaDueAt's own window varies (24h normally, 4h in a show's final
// week) and a fixed "N hours before due" threshold would warn far too late
// on the short window and far too early on the long one. Entry time comes
// from the most recent ArtworkOrderEvent with toStatus EXPO_PROOF_CHECK --
// an order can enter that status more than once across revision rounds, so
// this is deliberately "most recently entered," not "first ever."
export async function runSlaWarningSweep(now: Date = new Date()): Promise<SlaWarningSweepResult> {
  const candidates = await db.artworkOrder.findMany({
    where: { ...ACTIVE_ARTWORK_ORDER, status: "EXPO_PROOF_CHECK", slaDueAt: { not: null }, slaWarningNotifiedAt: null },
    select: { id: true, opportunityId: true, jobCode: true, slaDueAt: true },
  });
  if (candidates.length === 0) return { notified: 0 };

  const entryEvents = await db.artworkOrderEvent.findMany({
    where: { artworkOrderId: { in: candidates.map((o) => o.id) }, toStatus: "EXPO_PROOF_CHECK" },
    orderBy: { createdAt: "desc" },
    select: { artworkOrderId: true, createdAt: true },
  });
  const latestEntryAt = new Map<string, Date>();
  for (const e of entryEvents) {
    if (!latestEntryAt.has(e.artworkOrderId)) latestEntryAt.set(e.artworkOrderId, e.createdAt);
  }

  let notified = 0;
  for (const order of candidates) {
    const enteredAt = latestEntryAt.get(order.id);
    if (!enteredAt || !order.slaDueAt) continue;
    const halfway = new Date(enteredAt.getTime() + (order.slaDueAt.getTime() - enteredAt.getTime()) / 2);
    if (now < halfway) continue;

    await notifySlaWarning(order.opportunityId, order.jobCode, order.slaDueAt);
    await db.artworkOrder.update({ where: { id: order.id }, data: { slaWarningNotifiedAt: now } });
    notified++;
  }
  return { notified };
}
