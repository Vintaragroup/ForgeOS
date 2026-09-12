import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getReportsData } from "@/lib/reports";

afterEach(async () => {
  await db.stageChangeEvent.deleteMany();
  await db.opportunity.deleteMany();
  await db.show.deleteMany();
  await db.company.deleteMany();
  await db.user.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeAdmin() {
  return db.user.create({ data: { name: "Admin", email: `${Math.random()}@test.com`, systemRole: "ADMIN" } });
}

describe("getReportsData -- winRateByShow grouping", () => {
  it("groups two Show-linked opportunities under the real Show, even with differently-typed showName strings", async () => {
    const admin = await makeAdmin();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const show = await db.show.create({ data: { name: "2026 PGA Show" } });

    await db.opportunity.create({
      data: { companyId: company.id, showId: show.id, showName: "2026 PGA Show", stage: "WON" },
    });
    await db.opportunity.create({
      // Deliberately a differently-typed string for the same real show --
      // the old pure-string groupby would have split this into its own bucket.
      data: { companyId: company.id, showId: show.id, showName: "2026 PGA Show ", stage: "LOST" },
    });

    const { winRateByShow } = await getReportsData(admin);
    const row = winRateByShow.find((r) => r.showName === "2026 PGA Show");
    expect(row).toBeDefined();
    expect(row?.won).toBe(1);
    expect(row?.lost).toBe(1);
    expect(row?.total).toBe(2);
  });

  it("keeps an unlinked opportunity in its own showName-string bucket, unaffected by an unrelated Show with a similar name", async () => {
    const admin = await makeAdmin();
    const company = await db.company.create({ data: { name: "Test Co" } });
    await db.show.create({ data: { name: "Unrelated Show" } });

    await db.opportunity.create({
      data: { companyId: company.id, showName: "Standalone Job", stage: "WON" },
    });

    const { winRateByShow } = await getReportsData(admin);
    const row = winRateByShow.find((r) => r.showName === "Standalone Job");
    expect(row).toBeDefined();
    expect(row?.won).toBe(1);
    expect(row?.total).toBe(1);
  });

  it("does NOT merge two DIFFERENT real Shows even if their names happen to collide", async () => {
    const admin = await makeAdmin();
    const company = await db.company.create({ data: { name: "Test Co" } });
    const showA = await db.show.create({ data: { name: "Spring Expo" } });
    const showB = await db.show.create({ data: { name: "Spring Expo" } });

    await db.opportunity.create({ data: { companyId: company.id, showId: showA.id, showName: "Spring Expo", stage: "WON" } });
    await db.opportunity.create({ data: { companyId: company.id, showId: showB.id, showName: "Spring Expo", stage: "WON" } });

    const { winRateByShow } = await getReportsData(admin);
    const rows = winRateByShow.filter((r) => r.showName === "Spring Expo");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.won === 1)).toBe(true);
  });
});
