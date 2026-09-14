import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createArtworkOrder } from "@/lib/artwork-order-service";
import { runSlaWarningSweep } from "@/lib/artwork-sla-sweep";

afterEach(async () => {
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

const HOUR_MS = 60 * 60 * 1000;

// Fixture-seeded directly to EXPO_PROOF_CHECK with a controlled entry event
// and slaDueAt, rather than choreographed through the real state machine --
// this test is exercising the sweep's own halfway-point math and dedupe
// guard, not re-verifying transitionArtworkOrder (already covered in
// artwork-order-service.test.ts).
async function makeOrderInProofCheck(opts: {
  enteredHoursAgo: number;
  windowHours: number;
  alreadyNotified?: boolean;
}) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const order = await createArtworkOrder({ opportunityId: opportunity.id });

  const enteredAt = new Date(Date.now() - opts.enteredHoursAgo * HOUR_MS);
  const slaDueAt = new Date(enteredAt.getTime() + opts.windowHours * HOUR_MS);

  await db.artworkOrder.update({
    where: { id: order.id },
    data: {
      status: "EXPO_PROOF_CHECK",
      slaDueAt,
      slaWarningNotifiedAt: opts.alreadyNotified ? new Date() : null,
    },
  });
  await db.artworkOrderEvent.create({
    data: {
      artworkOrderId: order.id,
      toStatus: "EXPO_PROOF_CHECK",
      action: "TEST_ENTER_PROOF_CHECK",
      actorType: "SYSTEM",
      createdAt: enteredAt,
    },
  });

  return order;
}

describe("runSlaWarningSweep", () => {
  it("does not notify an order still in the first half of its SLA window", async () => {
    // 24h window, entered 4h ago -- well under the 12h halfway point.
    const order = await makeOrderInProofCheck({ enteredHoursAgo: 4, windowHours: 24 });

    const result = await runSlaWarningSweep();

    expect(result.notified).toBe(0);
    const updated = await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.slaWarningNotifiedAt).toBeNull();
  });

  it("notifies an order past the halfway point of its SLA window", async () => {
    // 24h window, entered 20h ago -- well past the 12h halfway point.
    const order = await makeOrderInProofCheck({ enteredHoursAgo: 20, windowHours: 24 });

    const result = await runSlaWarningSweep();

    expect(result.notified).toBe(1);
    const updated = await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.slaWarningNotifiedAt).not.toBeNull();
  });

  it("does not re-notify an order that's already been warned", async () => {
    await makeOrderInProofCheck({ enteredHoursAgo: 20, windowHours: 24, alreadyNotified: true });

    const result = await runSlaWarningSweep();

    expect(result.notified).toBe(0);
  });

  it("respects the shorter 4h final-week window the same way as the 24h normal one", async () => {
    // 4h window, entered 3h ago -- past the 2h halfway point.
    const order = await makeOrderInProofCheck({ enteredHoursAgo: 3, windowHours: 4 });

    const result = await runSlaWarningSweep();

    expect(result.notified).toBe(1);
    const updated = await db.artworkOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(updated.slaWarningNotifiedAt).not.toBeNull();
  });

  it("ignores an order not currently in EXPO_PROOF_CHECK even if its stale slaDueAt would otherwise qualify", async () => {
    const order = await makeOrderInProofCheck({ enteredHoursAgo: 20, windowHours: 24 });
    await db.artworkOrder.update({ where: { id: order.id }, data: { status: "PROOF_APPROVED" } });

    const result = await runSlaWarningSweep();

    expect(result.notified).toBe(0);
  });
});
