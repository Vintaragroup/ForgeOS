import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getGraphicsOrders } from "@/lib/artwork-hub";
import { runSlaWarningSweep } from "@/lib/artwork-sla-sweep";

// Archiving is a visibility rule, not a state change: an archived piece
// keeps whatever status it really reached and disappears only from the
// surfaces that ask "what is there to do?".

afterEach(async () => {
  await db.artworkOrderEvent.deleteMany();
  await db.artworkOrder.deleteMany();
  await db.opportunity.deleteMany();
  await db.show.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

const GR_USER = { id: "gr-1", systemRole: "EMPLOYEE" as const, departmentCode: "GR" };

let n = 0;
async function order(opportunityId: string, status: "PACKAGED_READY" | "IN_PRODUCTION" | "EXPO_PROOF_CHECK", archived: boolean) {
  n += 1;
  return db.artworkOrder.create({
    data: {
      opportunityId,
      status,
      jobCode: `SCOPE-${n}`,
      archivedAt: archived ? new Date("2026-09-21T00:00:00Z") : null,
      ...(status === "EXPO_PROOF_CHECK" ? { slaDueAt: new Date("2026-09-01T00:00:00Z") } : {}),
    },
  });
}

async function fixture() {
  await db.user.create({ data: { id: GR_USER.id, email: "gr@test.com", name: "GR", systemRole: "EMPLOYEE", departmentCode: "GR" } });
  const company = await db.company.create({ data: { name: "Scope Co" } });
  const show = await db.show.create({ data: { name: "Last Year's Show", eventStartDate: new Date("2026-04-07T00:00:00Z") } });
  const opportunity = await db.opportunity.create({
    data: { companyId: company.id, showName: "Last Year's Show", showId: show.id, stage: "WON" },
  });
  return { opportunity, show };
}

describe("archived artwork orders", () => {
  it("are left out of the Graphics Hub listing while live ones stay", async () => {
    const { opportunity } = await fixture();
    const live = await order(opportunity.id, "IN_PRODUCTION", false);
    await order(opportunity.id, "PACKAGED_READY", true);
    await order(opportunity.id, "IN_PRODUCTION", true);

    const orders = await getGraphicsOrders(GR_USER);
    expect(orders.map((o) => o.id)).toEqual([live.id]);
  });

  it("keep the status they actually reached", async () => {
    const { opportunity } = await fixture();
    const archived = await order(opportunity.id, "PACKAGED_READY", true);
    const row = await db.artworkOrder.findUniqueOrThrow({ where: { id: archived.id } });
    // The point of archiving instead of forcing a terminal state: a piece
    // that never shipped still says so.
    expect(row.status).toBe("PACKAGED_READY");
    expect(row.archivedAt).not.toBeNull();
  });

  it("never trigger an SLA warning", async () => {
    const { opportunity } = await fixture();
    await order(opportunity.id, "EXPO_PROOF_CHECK", true);

    const result = await runSlaWarningSweep(new Date("2026-09-21T12:00:00Z"));
    expect(result.notified).toBe(0);
    const row = await db.artworkOrder.findFirstOrThrow({ where: { status: "EXPO_PROOF_CHECK" } });
    expect(row.slaWarningNotifiedAt).toBeNull();
  });

  it("are still visible to a direct lookup, so history can be opened", async () => {
    const { opportunity } = await fixture();
    const archived = await order(opportunity.id, "PACKAGED_READY", true);
    expect(await db.artworkOrder.findUnique({ where: { id: archived.id } })).not.toBeNull();
  });
});
