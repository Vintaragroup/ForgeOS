import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import {
  getCutListCostReport,
  getCutSheetDiagramData,
  getMaterialWasteReport,
  optimizeNestingForMaterial,
  optimizeNestingForVersion,
  type PlacedPart,
} from "@/lib/cut-list-nesting-service";

afterEach(async () => {
  // MaterialRemnant.generatedByCutSheetId is ON DELETE RESTRICT -- must
  // clear remnants before their generating CutSheet, not after.
  await db.materialRemnant.deleteMany();
  await db.cutSheet.deleteMany();
  await db.cutListPart.deleteMany();
  await db.estimateVersion.deleteMany();
  await db.estimate.deleteMany();
  await db.material.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeVersion() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const estimate = await db.estimate.create({ data: { opportunityId: opportunity.id } });
  return createEstimateVersion(estimate.id, 0);
}

// 48x96 (a real 4x8 sheet in inches) is the fixture used throughout --
// matches how this material type is actually described in the real
// catalog seed data (prisma/seed.ts).
async function makeSheetMaterial(overrides: { stockWidth?: number; stockLength?: number; defaultKerf?: number } = {}) {
  return db.material.create({
    data: {
      name: "3/4in Plywood",
      currentUnitCost: 80,
      materialType: "SHEET",
      stockWidth: overrides.stockWidth ?? 48,
      stockLength: overrides.stockLength ?? 96,
      thickness: 0.75,
      defaultKerf: overrides.defaultKerf ?? 0.125,
    },
  });
}

async function makePart(
  estimateVersionId: string,
  materialId: string,
  data: { description: string; width: number; length: number; qty?: number; grainConstrained?: boolean },
) {
  return db.cutListPart.create({
    data: {
      estimateVersionId,
      materialId,
      description: data.description,
      width: data.width,
      length: data.length,
      qty: data.qty ?? 1,
      grainConstrained: data.grainConstrained ?? false,
    },
  });
}

function noOverlap(a: PlacedPart, b: PlacedPart): boolean {
  return a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
}

describe("optimizeNestingForMaterial", () => {
  it("packs two parts that fit on one sheet without overlapping, within the sheet bounds", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    const partA = await makePart(version.id, material.id, { description: "Side panel", width: 20, length: 30 });
    const partB = await makePart(version.id, material.id, { description: "Top panel", width: 20, length: 30 });

    const sheets = await optimizeNestingForMaterial(version.id, material.id);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toHaveLength(2);
    const [a, b] = sheets[0];
    expect(noOverlap(a, b)).toBe(true);
    for (const p of sheets[0]) {
      expect(p.x + p.width).toBeLessThanOrEqual(48);
      expect(p.y + p.height).toBeLessThanOrEqual(96);
    }
    expect(new Set(sheets[0].map((p) => p.cutListPartId))).toEqual(new Set([partA.id, partB.id]));

    const stored = await db.cutSheet.findMany({ where: { estimateVersionId: version.id, materialId: material.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0].sheetNumber).toBe(1);
  });

  it("places every instance of a part with qty > 1, none overlapping", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await makePart(version.id, material.id, { description: "Shelf", width: 10, length: 10, qty: 5 });

    const sheets = await optimizeNestingForMaterial(version.id, material.id);
    const allPlaced = sheets.flat();
    expect(allPlaced).toHaveLength(5);
    for (let i = 0; i < allPlaced.length; i++) {
      for (let j = i + 1; j < allPlaced.length; j++) {
        expect(noOverlap(allPlaced[i], allPlaced[j])).toBe(true);
      }
    }
  });

  it("rotates a part that only fits the sheet in the swapped orientation, and marks it rotated", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial(); // 48 wide x 96 long
    // 60 wide x 20 long does NOT fit as entered (60 > 48), but fits
    // rotated (20 <= 48, 60 <= 96) -- this is the exact real library
    // limitation confirmed live: maxrects-packer's own oversized check
    // would otherwise misclassify this as too big for the sheet.
    const part = await makePart(version.id, material.id, { description: "Long rail", width: 60, length: 20 });

    const sheets = await optimizeNestingForMaterial(version.id, material.id);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toHaveLength(1);
    const placed = sheets[0][0];
    expect(placed.cutListPartId).toBe(part.id);
    expect(placed.rotated).toBe(true);
    // As-placed dimensions are the swapped ones (20 x 60), not the
    // originally entered 60 x 20.
    expect([placed.width, placed.height].sort((a, b) => a - b)).toEqual([20, 60]);
  });

  it("throws for a grain-constrained part that only fits the sheet rotated, rather than silently reorienting it", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await makePart(version.id, material.id, { description: "Grain-critical face panel", width: 60, length: 20, grainConstrained: true });

    await expect(optimizeNestingForMaterial(version.id, material.id)).rejects.toThrow(/grain direction is constrained/);
  });

  it("throws for a part larger than the stock in every orientation", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await makePart(version.id, material.id, { description: "Oversized panel", width: 100, length: 100 });

    await expect(optimizeNestingForMaterial(version.id, material.id)).rejects.toThrow(/larger than the stock/);
  });

  it("throws a clear error for a material that isn't set up as sheet stock yet", async () => {
    const version = await makeVersion();
    const material = await db.material.create({ data: { name: "Contact cement", currentUnitCost: 12 } });
    await makePart(version.id, material.id, { description: "n/a", width: 1, length: 1 });

    await expect(optimizeNestingForMaterial(version.id, material.id)).rejects.toThrow(/isn't set up as sheet stock/);
  });

  it("throws for a sheet-good part missing a width", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await db.cutListPart.create({
      data: { estimateVersionId: version.id, materialId: material.id, description: "No width set", length: 10, qty: 1 },
    });

    await expect(optimizeNestingForMaterial(version.id, material.id)).rejects.toThrow(/has no width set/);
  });

  it("replaces existing CutSheet rows on re-run rather than duplicating them", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await makePart(version.id, material.id, { description: "Panel", width: 20, length: 20 });

    await optimizeNestingForMaterial(version.id, material.id);
    await optimizeNestingForMaterial(version.id, material.id);

    const stored = await db.cutSheet.findMany({ where: { estimateVersionId: version.id, materialId: material.id } });
    expect(stored).toHaveLength(1);
  });

  it("clears existing CutSheet rows and returns an empty layout when there are no parts left", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    const part = await makePart(version.id, material.id, { description: "Panel", width: 20, length: 20 });
    await optimizeNestingForMaterial(version.id, material.id);

    await db.cutListPart.update({ where: { id: part.id }, data: { deletedAt: new Date() } });
    const sheets = await optimizeNestingForMaterial(version.id, material.id);

    expect(sheets).toEqual([]);
    const stored = await db.cutSheet.findMany({ where: { estimateVersionId: version.id, materialId: material.id } });
    expect(stored).toHaveLength(0);
  });

  it("respects kerf as spacing between placed parts, not just a display value", async () => {
    const version = await makeVersion();
    // Tight on BOTH axes (not just width) -- confirmed live that the
    // packer will stack parts along whichever axis has room, so a sheet
    // that's only tight in one dimension doesn't actually exercise kerf
    // spacing; it just finds a placement along the other axis instead.
    // 20 + 20 = 40 exactly fills either axis with zero kerf; 20 + 5 + 20
    // = 45 doesn't fit either axis once 5" kerf spacing is added.
    const material = await makeSheetMaterial({ stockWidth: 40, stockLength: 40, defaultKerf: 5 });
    await makePart(version.id, material.id, { description: "Left half", width: 20, length: 20 });
    await makePart(version.id, material.id, { description: "Right half", width: 20, length: 20 });

    const sheets = await optimizeNestingForMaterial(version.id, material.id);
    expect(sheets.length).toBeGreaterThan(1);
  });
});

describe("optimizeNestingForMaterial -- remnant reuse (Phase 5)", () => {
  it("generates a shop-wide remnant from real leftover space above the minimum threshold", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial({ defaultKerf: 0 }); // 48x96
    await makePart(version.id, material.id, { description: "Small block", width: 10, length: 10 });

    await optimizeNestingForMaterial(version.id, material.id);

    const remnants = await db.materialRemnant.findMany({ where: { materialId: material.id } });
    expect(remnants).toHaveLength(1);
    expect(remnants[0].width.toNumber()).toBeGreaterThanOrEqual(6);
    expect(remnants[0].length.toNumber()).toBeGreaterThanOrEqual(6);
    expect(remnants[0].consumedAt).toBeNull();
  });

  it("does not persist a leftover region below the minimum remnant threshold", async () => {
    const version = await makeVersion();
    // A 20x20 sheet with an 18x20 part placed leaves only a 2"-wide
    // strip -- below MIN_REMNANT_DIMENSION (6") on that axis, so no
    // remnant candidate should survive extractLargestRemnantCandidate.
    const material = await makeSheetMaterial({ stockWidth: 20, stockLength: 20, defaultKerf: 0 });
    await makePart(version.id, material.id, { description: "Nearly full-width panel", width: 18, length: 20 });

    await optimizeNestingForMaterial(version.id, material.id);

    const remnants = await db.materialRemnant.findMany({ where: { materialId: material.id } });
    expect(remnants).toHaveLength(0);
  });

  it("consumes an available shop-wide remnant before buying a fresh sheet, when a part fits it", async () => {
    const material = await makeSheetMaterial({ defaultKerf: 0 }); // 48x96
    const versionA = await makeVersion();
    await makePart(versionA.id, material.id, { description: "Small block", width: 10, length: 10 });
    await optimizeNestingForMaterial(versionA.id, material.id);

    const remnant = await db.materialRemnant.findFirstOrThrow({ where: { materialId: material.id } });
    const remnantWidth = remnant.width.toNumber();
    const remnantLength = remnant.length.toNumber();

    // A different job (shop-wide reuse, not scoped to versionA) with a
    // part that comfortably fits inside the real remnant just generated.
    const versionB = await makeVersion();
    await makePart(versionB.id, material.id, {
      description: "Fits the remnant",
      width: Math.max(1, remnantWidth - 2),
      length: Math.max(1, remnantLength - 2),
    });

    const sheets = await optimizeNestingForMaterial(versionB.id, material.id);
    expect(sheets).toHaveLength(1);

    const storedB = await db.cutSheet.findMany({ where: { estimateVersionId: versionB.id, materialId: material.id } });
    expect(storedB).toHaveLength(1);
    expect(storedB[0].consumedRemnantId).toBe(remnant.id);

    const consumedRemnant = await db.materialRemnant.findUniqueOrThrow({ where: { id: remnant.id } });
    expect(consumedRemnant.consumedAt).not.toBeNull();
  });

  it("skips a remnant too small for the part, falling through to a fresh sheet", async () => {
    const material = await makeSheetMaterial({ defaultKerf: 0 }); // 48x96
    // Seed a real, but tiny, remnant directly -- tied to a throwaway
    // CutSheet in an unrelated version, matching how a remnant persists
    // independently of whichever job originally generated it.
    const seedVersion = await makeVersion();
    const seedSheet = await db.cutSheet.create({
      data: { estimateVersionId: seedVersion.id, materialId: material.id, sheetNumber: 1, layout: [] },
    });
    const smallRemnant = await db.materialRemnant.create({
      data: { materialId: material.id, width: 6, length: 6, generatedByCutSheetId: seedSheet.id },
    });

    const version = await makeVersion();
    await makePart(version.id, material.id, { description: "Too big for the tiny remnant", width: 10, length: 10 });

    const sheets = await optimizeNestingForMaterial(version.id, material.id);
    expect(sheets).toHaveLength(1);

    const stored = await db.cutSheet.findMany({ where: { estimateVersionId: version.id, materialId: material.id } });
    expect(stored[0].consumedRemnantId).toBeNull();

    const refreshedSmallRemnant = await db.materialRemnant.findUniqueOrThrow({ where: { id: smallRemnant.id } });
    expect(refreshedSmallRemnant.consumedAt).toBeNull();
  });

  it("re-optimizing gives back a previously-consumed remnant and doesn't duplicate a previously-generated one", async () => {
    const material = await makeSheetMaterial({ defaultKerf: 0 }); // 48x96
    const versionA = await makeVersion();
    await makePart(versionA.id, material.id, { description: "Small block", width: 10, length: 10 });
    await optimizeNestingForMaterial(versionA.id, material.id);

    const remnant = await db.materialRemnant.findFirstOrThrow({ where: { materialId: material.id } });
    const remnantWidth = remnant.width.toNumber();
    const remnantLength = remnant.length.toNumber();

    const versionB = await makeVersion();
    await makePart(versionB.id, material.id, {
      description: "Fits the remnant",
      width: Math.max(1, remnantWidth - 2),
      length: Math.max(1, remnantLength - 2),
    });
    await optimizeNestingForMaterial(versionB.id, material.id);

    const remnantIdsBefore = (await db.materialRemnant.findMany({ where: { materialId: material.id } }))
      .map((r) => r.id)
      .sort();

    await optimizeNestingForMaterial(versionB.id, material.id);

    const remnantsAfter = await db.materialRemnant.findMany({ where: { materialId: material.id } });
    expect(remnantsAfter.map((r) => r.id).sort()).toEqual(remnantIdsBefore);

    const reConsumedRemnant = await db.materialRemnant.findUniqueOrThrow({ where: { id: remnant.id } });
    expect(reConsumedRemnant.consumedAt).not.toBeNull();
  });

  it("splits fresh vs. remnant sheet cost in the waste/cost reports -- a remnant sheet costs $0", async () => {
    const material = await makeSheetMaterial({ defaultKerf: 0 }); // 48x96
    const versionA = await makeVersion();
    await makePart(versionA.id, material.id, { description: "Small block", width: 10, length: 10 });
    await optimizeNestingForMaterial(versionA.id, material.id);

    const remnant = await db.materialRemnant.findFirstOrThrow({ where: { materialId: material.id } });
    const versionB = await makeVersion();
    await makePart(versionB.id, material.id, {
      description: "Fits the remnant",
      width: Math.max(1, remnant.width.toNumber() - 2),
      length: Math.max(1, remnant.length.toNumber() - 2),
    });
    await optimizeNestingForMaterial(versionB.id, material.id);

    const report = await getMaterialWasteReport(versionB.id, material.id);
    expect(report.sheetsUsed).toBe(1);
    expect(report.freshSheetsUsed).toBe(0);
    expect(report.remnantSheetsUsed).toBe(1);
    expect(report.totalCost).toBe(0);

    const rollup = await getCutListCostReport(versionB.id);
    expect(rollup.totalCost).toBe(0);
    expect(rollup.totalSheetsUsed).toBe(1);
  });
});

describe("optimizeNestingForVersion", () => {
  it("optimizes every distinct material used, reporting sheet counts, and skips a material that isn't set up as stock", async () => {
    const version = await makeVersion();
    const plywood = await makeSheetMaterial();
    const cement = await db.material.create({ data: { name: "Contact cement", currentUnitCost: 12 } });
    await makePart(version.id, plywood.id, { description: "Panel", width: 20, length: 20 });
    await makePart(version.id, cement.id, { description: "n/a", width: 1, length: 1 });

    const result = await optimizeNestingForVersion(version.id);

    expect(result.optimized).toEqual([{ materialId: plywood.id, materialName: plywood.name, sheetCount: 1 }]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].materialId).toBe(cement.id);
    expect(result.skipped[0].reason).toMatch(/isn't set up as sheet stock/);
  });
});

describe("getCutSheetDiagramData", () => {
  it("joins each sheet's placed parts back to their real descriptions", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    const partA = await makePart(version.id, material.id, { description: "Side panel", width: 20, length: 20 });
    const partB = await makePart(version.id, material.id, { description: "Top panel", width: 15, length: 15 });
    await optimizeNestingForMaterial(version.id, material.id);

    const data = await getCutSheetDiagramData(version.id, material.id);

    expect(data.materialName).toBe(material.name);
    expect(data.stockWidth).toBe(48);
    expect(data.stockLength).toBe(96);
    expect(data.sheets).toHaveLength(1);
    expect(data.sheets[0].sheetNumber).toBe(1);
    const descriptions = data.sheets[0].parts.map((p) => p.description).sort();
    expect(descriptions).toEqual(["Side panel", "Top panel"]);
    const byId = new Map(data.sheets[0].parts.map((p) => [p.cutListPartId, p]));
    expect(byId.get(partA.id)?.description).toBe("Side panel");
    expect(byId.get(partB.id)?.description).toBe("Top panel");
  });

  it("throws a clear, actionable error when nothing has been optimized yet", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await makePart(version.id, material.id, { description: "Panel", width: 20, length: 20 });
    // Deliberately no optimizeNestingForMaterial call.

    await expect(getCutSheetDiagramData(version.id, material.id)).rejects.toThrow(/run Optimize first/);
  });

  it("reflects multiple sheets in order when a material's parts span more than one", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial({ stockWidth: 20, stockLength: 20 });
    await makePart(version.id, material.id, { description: "Big panel A", width: 18, length: 18 });
    await makePart(version.id, material.id, { description: "Big panel B", width: 18, length: 18 });
    await optimizeNestingForMaterial(version.id, material.id);

    const data = await getCutSheetDiagramData(version.id, material.id);

    expect(data.sheets.map((s) => s.sheetNumber)).toEqual([1, 2]);
  });
});

describe("getMaterialWasteReport", () => {
  it("computes exact waste and cost from the real packed layout, not an estimate", async () => {
    const version = await makeVersion();
    // 48x96 = 4608 sq in per sheet, $100/sheet. One 48x48 part (2304 sq
    // in) easily fits on a single sheet -- hand-computable expected
    // result: 1 sheet, $100 cost, exactly 50% waste.
    const material = await db.material.create({
      data: {
        name: "3/4in Plywood",
        currentUnitCost: 100,
        materialType: "SHEET",
        stockWidth: 48,
        stockLength: 96,
        defaultKerf: 0,
      },
    });
    await makePart(version.id, material.id, { description: "Half sheet", width: 48, length: 48 });
    await optimizeNestingForMaterial(version.id, material.id);

    const report = await getMaterialWasteReport(version.id, material.id);

    expect(report.sheetsUsed).toBe(1);
    expect(report.totalCost).toBe(100);
    expect(report.usedAreaSqIn).toBe(48 * 48);
    expect(report.totalStockAreaSqIn).toBe(48 * 96);
    expect(report.wastePct).toBeCloseTo(0.5, 5);
  });

  it("scales cost and stock area with the number of sheets actually used", async () => {
    const version = await makeVersion();
    const material = await db.material.create({
      data: { name: "MDF", currentUnitCost: 50, materialType: "SHEET", stockWidth: 20, stockLength: 20, defaultKerf: 0 },
    });
    // Two 18x18 parts can't share one 20x20 sheet -- forces 2 sheets.
    await makePart(version.id, material.id, { description: "Panel A", width: 18, length: 18 });
    await makePart(version.id, material.id, { description: "Panel B", width: 18, length: 18 });
    await optimizeNestingForMaterial(version.id, material.id);

    const report = await getMaterialWasteReport(version.id, material.id);

    expect(report.sheetsUsed).toBe(2);
    expect(report.totalCost).toBe(100);
    expect(report.totalStockAreaSqIn).toBe(2 * 20 * 20);
  });

  it("throws a clear error when nothing has been optimized for this material yet", async () => {
    const version = await makeVersion();
    const material = await makeSheetMaterial();
    await makePart(version.id, material.id, { description: "Panel", width: 10, length: 10 });

    await expect(getMaterialWasteReport(version.id, material.id)).rejects.toThrow(/run Optimize first/);
  });
});

describe("getCutListCostReport", () => {
  it("rolls up every optimized material's cost and sheet count", async () => {
    const version = await makeVersion();
    const plywood = await db.material.create({
      data: { name: "Plywood", currentUnitCost: 100, materialType: "SHEET", stockWidth: 48, stockLength: 96, defaultKerf: 0 },
    });
    const mdf = await db.material.create({
      data: { name: "MDF", currentUnitCost: 50, materialType: "SHEET", stockWidth: 48, stockLength: 96, defaultKerf: 0 },
    });
    await makePart(version.id, plywood.id, { description: "Panel", width: 20, length: 20 });
    await makePart(version.id, mdf.id, { description: "Panel", width: 20, length: 20 });
    await optimizeNestingForMaterial(version.id, plywood.id);
    await optimizeNestingForMaterial(version.id, mdf.id);

    const report = await getCutListCostReport(version.id);

    expect(report.materials).toHaveLength(2);
    expect(report.totalSheetsUsed).toBe(2);
    expect(report.totalCost).toBe(150);
  });

  it("returns an empty report when nothing in this version has been optimized", async () => {
    const version = await makeVersion();
    const report = await getCutListCostReport(version.id);
    expect(report).toEqual({ materials: [], totalCost: 0, totalSheetsUsed: 0 });
  });
});
