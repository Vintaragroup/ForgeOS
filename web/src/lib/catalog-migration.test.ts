import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  STANDARD_RATE_TAG,
  mapMaterialCategory,
  mapRentalCategory,
  migrateLegacyCatalog,
} from "@/lib/catalog-migration";

afterEach(async () => {
  await db.catalogItemTag.deleteMany();
  await db.catalogItemAlias.deleteMany();
  await db.catalogItem.deleteMany();
  await db.catalogTag.deleteMany();
  await db.catalogCategory.deleteMany();
  await db.catalogNumberSequence.deleteMany();
  await db.office.deleteMany();
  await db.rentalItem.deleteMany();
  await db.material.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

describe("legacy category mapping", () => {
  it("maps material categories case-insensitively, falling back to MSC", () => {
    expect(mapMaterialCategory("Wood & Sheet Goods")).toMatchObject({ itemType: "MATERIAL", categoryCode: "WSG", unmapped: false });
    expect(mapMaterialCategory("bematrix system")).toMatchObject({ categoryCode: "BMX", unmapped: false });
    expect(mapMaterialCategory("Mystery Goods")).toMatchObject({ categoryCode: "MSC", unmapped: true });
    expect(mapMaterialCategory(null)).toMatchObject({ categoryCode: "MSC", unmapped: true });
  });

  it("folds (Standard Rate) rental categories into the real one plus a tag, and routes services to S-", () => {
    expect(mapRentalCategory("Furniture (Standard Rate)")).toEqual({
      itemType: "RENTAL",
      categoryCode: "FUR",
      tags: [STANDARD_RATE_TAG],
      unmapped: false,
    });
    expect(mapRentalCategory("A/V")).toMatchObject({ itemType: "RENTAL", categoryCode: "AVL", tags: [] });
    expect(mapRentalCategory("Design Time")).toMatchObject({ itemType: "SERVICE", categoryCode: "DSN" });
    expect(mapRentalCategory("Shipping")).toMatchObject({ itemType: "SERVICE", categoryCode: "SHP" });
  });
});

describe("migrateLegacyCatalog", () => {
  async function seedLegacy() {
    const plywood = await db.material.create({
      data: {
        name: "3/4 Birch Plywood",
        unit: "sheet",
        currentUnitCost: "62.50",
        category: "Wood & Sheet Goods",
        materialType: "SHEET",
        stockWidth: "48",
        stockLength: "96",
        thickness: "0.75",
        defaultKerf: "0.125",
        grainDirectionMatters: true,
      },
    });
    const mdf = await db.material.create({ data: { name: "1/2 MDF", currentUnitCost: "30", category: "Wood & Sheet Goods" } });
    const sofa = await db.rentalItem.create({ data: { name: "Sofa - White", unitPrice: "450", category: "Furniture" } });
    const counter = await db.rentalItem.create({
      data: { name: "80in Reception Counter", unitPrice: "400", category: "Furniture (Standard Rate)", priceDerivationNote: "Standard Cost Sheet row 17" },
    });
    const design = await db.rentalItem.create({ data: { name: "Design Hour", unitPrice: "95", category: "Design Time" } });
    return { plywood, mdf, sofa, counter, design };
  }

  it("creates one numbered item per legacy row, numbered by name within each (type, category)", async () => {
    const legacy = await seedLegacy();
    const report = await migrateLegacyCatalog(db);

    expect(report.created).toHaveLength(5);
    expect(report.totalItems).toBe(5);

    const byLegacy = async (where: object) => db.catalogItem.findFirstOrThrow({ where, include: { tags: { include: { tag: true } } } });
    // "1/2 MDF" sorts before "3/4 Birch Plywood".
    expect((await byLegacy({ legacyMaterialId: legacy.mdf.id })).catalogNumber).toBe("M-WSG-0001");
    const plywood = await byLegacy({ legacyMaterialId: legacy.plywood.id });
    expect(plywood.catalogNumber).toBe("M-WSG-0002");
    expect(plywood.unitCost?.toString()).toBe("62.5");
    expect(plywood.unitPrice).toBeNull();
    expect(plywood.materialType).toBe("SHEET");
    expect(plywood.stockWidth?.toString()).toBe("48");
    expect(plywood.grainDirectionMatters).toBe(true);

    // "80in Reception Counter" sorts before "Sofa - White" -- one FUR sequence despite two legacy categories.
    const counter = await byLegacy({ legacyRentalItemId: legacy.counter.id });
    expect(counter.catalogNumber).toBe("R-FUR-0001");
    expect(counter.unitPrice?.toString()).toBe("400");
    expect(counter.sourceNote).toBe("Standard Cost Sheet row 17");
    expect(counter.tags.map((t) => t.tag.name)).toEqual([STANDARD_RATE_TAG]);
    expect((await byLegacy({ legacyRentalItemId: legacy.sofa.id })).catalogNumber).toBe("R-FUR-0002");
    expect((await byLegacy({ legacyRentalItemId: legacy.design.id })).catalogNumber).toBe("S-DSN-0001");

    expect(await db.office.findUnique({ where: { code: "ORL" } })).toMatchObject({ isStandard: true });
  });

  it("is a no-op on re-run: nothing created, same checksum", async () => {
    await seedLegacy();
    const first = await migrateLegacyCatalog(db);
    const second = await migrateLegacyCatalog(db);

    expect(second.created).toHaveLength(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(5);
    expect(second.checksum).toBe(first.checksum);
    expect(await db.catalogItemTag.count()).toBe(1);
  });

  it("syncs a later legacy edit -- including a category move -- without ever changing the number", async () => {
    const legacy = await seedLegacy();
    await migrateLegacyCatalog(db);

    await db.rentalItem.update({ where: { id: legacy.sofa.id }, data: { unitPrice: "475", category: "Accessories" } });
    const report = await migrateLegacyCatalog(db);

    expect(report.updated).toBe(1);
    const sofa = await db.catalogItem.findFirstOrThrow({ where: { legacyRentalItemId: legacy.sofa.id } });
    expect(sofa.catalogNumber).toBe("R-FUR-0002");
    expect(sofa.categoryCode).toBe("ACC");
    expect(sofa.unitPrice?.toString()).toBe("475");
  });

  it("numbers a new legacy row after the existing ones, and retires an item whose legacy row was deleted", async () => {
    const legacy = await seedLegacy();
    await migrateLegacyCatalog(db);

    await db.rentalItem.update({ where: { id: legacy.sofa.id }, data: { deletedAt: new Date() } });
    const armchair = await db.rentalItem.create({ data: { name: "Armchair", unitPrice: "150", category: "Furniture" } });
    const report = await migrateLegacyCatalog(db);

    expect(report.retired).toEqual(["R-FUR-0002"]);
    // Sorts first alphabetically, but R-FUR-0001/0002 are taken -- and 0002 isn't reused after retirement.
    expect(report.created).toEqual([{ catalogNumber: "R-FUR-0003", name: "Armchair", source: "rental" }]);
    expect((await db.catalogItem.findFirstOrThrow({ where: { legacyRentalItemId: armchair.id } })).catalogNumber).toBe("R-FUR-0003");
  });

  it("files unmapped categories under MSC with a warning, and warns when an estimate category doesn't exist", async () => {
    await db.material.create({ data: { name: "Unobtainium", currentUnitCost: "1", category: "Exotic" } });
    const report = await migrateLegacyCatalog(db);

    expect(report.created[0].catalogNumber).toBe("M-MSC-0001");
    expect(report.warnings.some((w) => w.includes("Unobtainium") && w.includes("MSC"))).toBe(true);
    // forgeos_test has no seeded estimate Category rows, so every link is reported, not silently dropped.
    expect(report.warnings.some((w) => w.includes('"furniture"') && w.includes("FUR"))).toBe(true);
    expect((await db.catalogCategory.findUniqueOrThrow({ where: { code: "FUR" } })).estimateCategoryKey).toBeNull();
  });

  it("reports same-name items and BeMatrix buy/rent pairs for review instead of merging them", async () => {
    await db.material.create({ data: { name: "M8 Door Bolt", currentUnitCost: "2", category: "BeMatrix System" } });
    await db.rentalItem.create({ data: { name: "M8 DOOR BOLT", unitPrice: "5", category: "BeMatrix System" } });
    const report = await migrateLegacyCatalog(db);

    expect(report.totalItems).toBe(2);
    expect(report.duplicateNames).toEqual([{ name: "m8 door bolt", catalogNumbers: ["M-BMX-0001", "R-BMX-0001"] }]);
    expect(report.bematrixPairs).toEqual([{ name: "M8 Door Bolt", material: "M-BMX-0001", rental: "R-BMX-0001" }]);
  });
});
