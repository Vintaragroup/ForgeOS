import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { allocateCatalogNumber, formatCatalogNumber, parseCatalogNumber } from "@/lib/catalog-number";

afterEach(async () => {
  await db.catalogNumberSequence.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("formatCatalogNumber / parseCatalogNumber", () => {
  it("formats TYPE-CAT-#### with a zero-padded sequence", () => {
    expect(formatCatalogNumber("RENTAL", "FUR", 1)).toBe("R-FUR-0001");
    expect(formatCatalogNumber("MATERIAL", "WSG", 142)).toBe("M-WSG-0142");
    expect(formatCatalogNumber("SERVICE", "DSN", 3)).toBe("S-DSN-0003");
  });

  it("keeps working past 9999 instead of wrapping or truncating", () => {
    expect(formatCatalogNumber("RENTAL", "FUR", 12345)).toBe("R-FUR-12345");
    expect(parseCatalogNumber("R-FUR-12345")).toEqual({ itemType: "RENTAL", categoryCode: "FUR", sequence: 12345 });
  });

  it("rejects a malformed category code or sequence", () => {
    expect(() => formatCatalogNumber("RENTAL", "FURN", 1)).toThrow(/3 uppercase letters/);
    expect(() => formatCatalogNumber("RENTAL", "fur", 1)).toThrow(/3 uppercase letters/);
    expect(() => formatCatalogNumber("RENTAL", "FUR", 0)).toThrow(/positive integer/);
  });

  it("parses case-insensitively and round-trips, returning null for anything else", () => {
    expect(parseCatalogNumber(" m-wsg-0142 ")).toEqual({ itemType: "MATERIAL", categoryCode: "WSG", sequence: 142 });
    expect(parseCatalogNumber(formatCatalogNumber("SERVICE", "SHP", 7))).toEqual({
      itemType: "SERVICE",
      categoryCode: "SHP",
      sequence: 7,
    });
    expect(parseCatalogNumber("X-FUR-0001")).toBeNull();
    expect(parseCatalogNumber("R-FUR-01")).toBeNull();
    expect(parseCatalogNumber("chair")).toBeNull();
  });
});

describe("allocateCatalogNumber", () => {
  it("counts independently per (type, category) -- BMX as material and as rental don't share a sequence", async () => {
    expect(await allocateCatalogNumber(db, "RENTAL", "BMX")).toBe("R-BMX-0001");
    expect(await allocateCatalogNumber(db, "RENTAL", "BMX")).toBe("R-BMX-0002");
    expect(await allocateCatalogNumber(db, "MATERIAL", "BMX")).toBe("M-BMX-0001");
    expect(await allocateCatalogNumber(db, "RENTAL", "FUR")).toBe("R-FUR-0001");
  });

  it("never hands out the same number twice under concurrent allocation", async () => {
    const numbers = await Promise.all(Array.from({ length: 25 }, () => allocateCatalogNumber(db, "RENTAL", "FUR")));
    expect(new Set(numbers).size).toBe(25);
    expect(numbers.map((n) => parseCatalogNumber(n)!.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
  });

  it("rolls the reservation back with a failed transaction, so no number is burned", async () => {
    await expect(
      db.$transaction(async (tx) => {
        await allocateCatalogNumber(tx, "RENTAL", "ACC");
        throw new Error("create failed");
      }),
    ).rejects.toThrow("create failed");
    expect(await allocateCatalogNumber(db, "RENTAL", "ACC")).toBe("R-ACC-0001");
  });
});
