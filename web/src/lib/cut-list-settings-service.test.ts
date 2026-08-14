import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getCutListSettings, updateCutListSettings } from "@/lib/cut-list-settings-service";

afterEach(async () => {
  await db.cutListSettings.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("getCutListSettings", () => {
  it("lazily creates the singleton row with the schema's own defaults on first read", async () => {
    expect(await db.cutListSettings.count()).toBe(0);

    const settings = await getCutListSettings();

    expect(settings.defaultKerf.toNumber()).toBe(0.125);
    expect(settings.minRemnantDimension.toNumber()).toBe(6);
    expect(settings.dragGridSnap.toNumber()).toBe(0.25);
    expect(await db.cutListSettings.count()).toBe(1);
  });

  it("returns the same row on a second call, not a duplicate", async () => {
    const first = await getCutListSettings();
    const second = await getCutListSettings();

    expect(second.id).toBe(first.id);
    expect(await db.cutListSettings.count()).toBe(1);
  });
});

describe("updateCutListSettings", () => {
  it("persists new values on the existing singleton row", async () => {
    const original = await getCutListSettings();

    const updated = await updateCutListSettings({ defaultKerf: 0.25, minRemnantDimension: 4, dragGridSnap: 0.5 });

    expect(updated.id).toBe(original.id);
    expect(updated.defaultKerf.toNumber()).toBe(0.25);
    expect(updated.minRemnantDimension.toNumber()).toBe(4);
    expect(updated.dragGridSnap.toNumber()).toBe(0.5);
    expect(await db.cutListSettings.count()).toBe(1);
  });

  it("lazily creates the row first if none exists yet, rather than throwing", async () => {
    expect(await db.cutListSettings.count()).toBe(0);

    // Decimal(6,3) -- 3 decimal places max, same precision as
    // Material.defaultKerf already uses elsewhere in this schema.
    const updated = await updateCutListSettings({ defaultKerf: 0.188, minRemnantDimension: 8, dragGridSnap: 0.125 });

    expect(updated.defaultKerf.toNumber()).toBe(0.188);
    expect(await db.cutListSettings.count()).toBe(1);
  });
});
