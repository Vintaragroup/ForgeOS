import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { canViewWholeTeam, dealWonAt, loadLeaderboard, loadSalesOverview } from "@/lib/sales-analytics";

const NOW = new Date("2026-09-20T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

afterEach(async () => {
  // FK order: proposals -> versions -> estimates -> opportunities.
  await db.salesmateDeal.deleteMany();
  await db.salesmateCompany.deleteMany();
  await db.contact.deleteMany();
  await db.proposal.deleteMany();
  await db.proposalTemplate.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function rep(name: string, extra: { isSalesManager?: boolean } = {}) {
  return db.user.create({
    data: { name, email: `${name.replace(/\W/g, "")}.${Math.random().toString(36).slice(2)}@expocci.com`, systemRole: "EMPLOYEE", ...extra },
  });
}

async function client(name: string, ownerUserId: string | null, salesmateId: string, lastComm: Date | null, type = "Customer") {
  const company = await db.company.create({ data: { name } });
  await db.salesmateCompany.create({
    data: { salesmateId, name, type, companyId: company.id, ownerUserId, lastCommunicationAt: lastComm, syncedAt: NOW },
  });
  return company;
}

async function dealFor(
  companyId: string | null,
  ownerUserId: string | null,
  data: { id: string; status: string; value: number; pipeline?: string | null; stage?: string | null; closedAt?: Date | null; lastComm?: Date | null; ownerName?: string },
) {
  return db.salesmateDeal.create({
    data: {
      salesmateId: data.id,
      title: `${data.status} deal ${data.id}`,
      status: data.status,
      pipeline: data.pipeline ?? null,
      stage: data.stage ?? null,
      value: data.value,
      companyId,
      ownerUserId,
      ownerName: data.ownerName ?? null,
      closedAt: data.closedAt ?? null,
      lastCommunicationAt: data.lastComm ?? null,
      syncedAt: NOW,
    },
  });
}

describe("dealWonAt", () => {
  it("prefers Salesmate's closed date, and falls back to the pipeline's show month", () => {
    expect(dealWonAt({ closedAt: new Date("2026-03-11T00:00:00Z"), pipeline: "Pipeline 2026", stage: "January" })?.toISOString()).toBe(
      "2026-03-11T00:00:00.000Z",
    );
    expect(dealWonAt({ closedAt: null, pipeline: "Pipeline 2026", stage: "January" })?.toISOString()).toBe("2026-01-31T12:00:00.000Z");
    expect(dealWonAt({ closedAt: null, pipeline: "Sales-Orlando", stage: "PROPOSAL" })).toBeNull();
  });
});

describe("loadSalesOverview", () => {
  it("totals one rep's book: won/open value, win rate, per-client value, and nobody else's deals", async () => {
    const terry = await rep("Terry");
    const craig = await rep("Craig");
    const acme = await client("Acme", terry.id, "1", daysAgo(10));
    const globex = await client("Globex", terry.id, "2", daysAgo(200));
    const other = await client("Not Mine", craig.id, "3", daysAgo(5));

    await dealFor(acme.id, terry.id, { id: "100", status: "Won", value: 50_000, closedAt: daysAgo(30) });
    await dealFor(acme.id, terry.id, { id: "101", status: "Won", value: 20_000, closedAt: daysAgo(400) }); // outside 12mo
    await dealFor(globex.id, terry.id, { id: "102", status: "Lost", value: 30_000, closedAt: daysAgo(60) });
    await dealFor(globex.id, terry.id, { id: "103", status: "Open", value: 75_000, stage: "PROPOSAL", lastComm: daysAgo(5) });
    await dealFor(other.id, craig.id, { id: "104", status: "Won", value: 999_000, closedAt: daysAgo(10) });

    const overview = await loadSalesOverview({ ownerUserId: terry.id }, NOW);

    expect(overview.kpis).toMatchObject({
      wonValue12mo: 50_000,
      wonCount12mo: 1,
      openValue: 75_000,
      openCount: 1,
      activeClients: 2,
      avgWonDealValue: 35_000, // (50k + 20k) / 2 deals, lifetime
    });
    expect(overview.kpis.winRateCount).toBeCloseTo(0.5); // 1 won, 1 lost in 12mo
    expect(overview.kpis.winRateValue).toBeCloseTo(50_000 / 80_000);

    const acmeRow = overview.clients.find((c) => c.name === "Acme")!;
    expect(acmeRow).toMatchObject({ lifetimeWonValue: 70_000, wonValue12mo: 50_000, wonCount: 2, openValue: 0 });
    expect(overview.clients.map((c) => c.name)).not.toContain("Not Mine");
    expect(overview.pipelineByStage).toEqual([{ stage: "PROPOSAL", count: 1, value: 75_000 }]);
  });

  it("ranks going-cold clients by value times silence, not by date alone", async () => {
    const terry = await rep("Terry");
    const big = await client("Big Fish", terry.id, "1", daysAgo(100));
    const small = await client("Small Fry", terry.id, "2", daysAgo(365));
    const recent = await client("Just Talked", terry.id, "3", daysAgo(3));
    await dealFor(big.id, terry.id, { id: "100", status: "Won", value: 200_000, closedAt: daysAgo(200) });
    await dealFor(small.id, terry.id, { id: "101", status: "Won", value: 2_000, closedAt: daysAgo(300) });
    await dealFor(recent.id, terry.id, { id: "102", status: "Won", value: 500_000, closedAt: daysAgo(30) });

    const { goingCold } = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(goingCold.map((c) => c.name)).toEqual(["Big Fish", "Small Fry"]);
  });

  it("flags open deals nobody has touched in 30+ days, and counts a never-touched one first", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(1));
    await dealFor(acme.id, terry.id, { id: "100", status: "Open", value: 10_000, lastComm: daysAgo(45) });
    await dealFor(acme.id, terry.id, { id: "101", status: "Open", value: 5_000, lastComm: daysAgo(3) });
    await dealFor(acme.id, terry.id, { id: "102", status: "Open", value: 80_000 });

    const { staleOpenDeals } = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(staleOpenDeals.map((d) => d.salesmateId)).toEqual(["102", "100"]);
    expect(staleOpenDeals[0]).toMatchObject({ daysQuiet: -1, companyName: "Acme" });
    expect(staleOpenDeals[1].daysQuiet).toBe(45);
  });

  it("counts ForgeOS proposals per client alongside the Salesmate money", async () => {
    const terry = await rep("Terry");
    const acme = await client("Acme", terry.id, "1", daysAgo(5));
    const opportunity = await db.opportunity.create({ data: { companyId: acme.id, showName: "PGA Show", stage: "WON", eventEndDate: daysAgo(20) } });
    const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
    const version = await db.estimateVersion.create({ data: { estimateId: estimate.id, versionNumber: 1 } });
    const template = await db.proposalTemplate.create({ data: { name: `Template ${Math.random()}` } });
    await db.proposal.create({ data: { estimateVersionId: version.id, templateId: template.id, sentAt: daysAgo(10) } });
    await db.proposal.create({ data: { estimateVersionId: version.id, templateId: template.id, sentAt: daysAgo(40), signedAt: daysAgo(35) } });

    const overview = await loadSalesOverview({ ownerUserId: terry.id }, NOW);
    expect(overview.clients[0]).toMatchObject({ name: "Acme", proposalsSent: 2, proposalsSigned: 1 });
    expect(overview.forgeos).toMatchObject({ proposalsSent: 2, proposalsSigned: 1 });
    // A won ForgeOS job dates "last worked with" from its event.
    expect(overview.clients[0].lastWorkedWithAt?.toISOString()).toBe(daysAgo(20).toISOString());
  });

  it("with no owner scope, totals the whole team", async () => {
    const terry = await rep("Terry");
    const craig = await rep("Craig");
    const a = await client("A", terry.id, "1", daysAgo(5));
    const b = await client("B", craig.id, "2", daysAgo(5));
    await dealFor(a.id, terry.id, { id: "100", status: "Won", value: 10_000, closedAt: daysAgo(10) });
    await dealFor(b.id, craig.id, { id: "101", status: "Won", value: 40_000, closedAt: daysAgo(10) });

    const overview = await loadSalesOverview({ ownerUserId: null }, NOW);
    expect(overview.kpis.wonValue12mo).toBe(50_000);
    expect(overview.clients).toHaveLength(2);
  });
});

describe("loadLeaderboard", () => {
  it("ranks reps by 12-month won value and keeps a former rep's book visible", async () => {
    const terry = await rep("Terry");
    const craig = await rep("Craig");
    const a = await client("A", terry.id, "1", daysAgo(10));
    const b = await client("B", craig.id, "2", daysAgo(200));
    const orphan = await client("Orphan Co", null, "3", daysAgo(400));

    await dealFor(a.id, terry.id, { id: "100", status: "Won", value: 100_000, closedAt: daysAgo(30) });
    await dealFor(a.id, terry.id, { id: "101", status: "Lost", value: 50_000, closedAt: daysAgo(30) });
    await dealFor(b.id, craig.id, { id: "102", status: "Won", value: 300_000, closedAt: daysAgo(30) });
    await dealFor(b.id, craig.id, { id: "103", status: "Open", value: 70_000 });
    await dealFor(orphan.id, null, { id: "104", status: "Won", value: 25_000, closedAt: daysAgo(30), ownerName: "David I. Stelly" });

    const board = await loadLeaderboard(NOW);
    expect(board.map((r) => r.name)).toEqual(["Craig", "Terry", "Former reps"]);
    expect(board[0]).toMatchObject({ wonValue12mo: 300_000, openValue: 70_000, clients: 1, coldClients: 1 });
    expect(board[0].medianDaysSinceContact).toBe(200);
    expect(board[1]).toMatchObject({ wonValue12mo: 100_000, coldClients: 0 });
    expect(board[1].winRateCount).toBeCloseTo(0.5);
    expect(board[2]).toMatchObject({ isFormer: true, wonValue12mo: 25_000, userId: null });
  });
});

describe("canViewWholeTeam", () => {
  it("is admins and designated sales managers only", () => {
    expect(canViewWholeTeam({ systemRole: "EMPLOYEE", isSalesManager: false })).toBe(false);
    expect(canViewWholeTeam({ systemRole: "EMPLOYEE", isSalesManager: true })).toBe(true);
    expect(canViewWholeTeam({ systemRole: "ADMIN", isSalesManager: false })).toBe(true);
    expect(canViewWholeTeam({ systemRole: "SUPER_ADMIN", isSalesManager: false })).toBe(true);
  });
});
