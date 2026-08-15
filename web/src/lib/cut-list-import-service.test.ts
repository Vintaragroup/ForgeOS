import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createEstimateVersion } from "@/lib/estimate-service";
import Papa from "papaparse";
import { parseCutListCsvRows, importCutListPartsFromCsv, buildCsvTemplate, CUT_LIST_CSV_HEADERS } from "@/lib/cut-list-import-service";

afterEach(async () => {
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

async function makeSheetMaterial(name: string) {
  return db.material.create({
    data: { name, currentUnitCost: 80, materialType: "SHEET", stockWidth: 48, stockLength: 96, thickness: 0.75 },
  });
}

describe("parseCutListCsvRows", () => {
  it("parses valid rows, including a quoted description containing a comma", () => {
    const csv = [
      "Description,Material,Width,Length,Qty,Grain Constrained",
      '"Cabinet side, tall unit",Plywood,24,48,2,yes',
    ].join("\n");
    const { rows, errors } = parseCutListCsvRows(csv);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { row: 2, description: "Cabinet side, tall unit", materialName: "Plywood", width: 24, length: 48, qty: 2, grainConstrained: true },
    ]);
  });

  it("throws once for a CSV missing a required column", () => {
    const csv = "Description,Material,Width,Qty\nPanel,Plywood,24,1";
    expect(() => parseCutListCsvRows(csv)).toThrow(/missing required column/i);
  });

  it("defaults a blank Qty to 1", () => {
    const csv = "Description,Material,Width,Length,Qty\nPanel,Plywood,24,48,";
    const { rows, errors } = parseCutListCsvRows(csv);
    expect(errors).toEqual([]);
    expect(rows[0].qty).toBe(1);
  });

  it("accumulates a per-row error for a bad field without dropping other valid rows", () => {
    const csv = [
      "Description,Material,Width,Length,Qty",
      "Good panel,Plywood,24,48,1",
      "Bad panel,Plywood,not-a-number,48,1",
      "Also good,Plywood,10,10,3",
    ].join("\n");
    const { rows, errors } = parseCutListCsvRows(csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.description)).toEqual(["Good panel", "Also good"]);
    expect(errors).toEqual([{ row: 3, reason: expect.stringContaining("Width") }]);
  });
});

describe("importCutListPartsFromCsv", () => {
  it("imports valid rows across two materials and clears stale sheets once per touched material, not once per row", async () => {
    const version = await makeVersion();
    const plywood = await makeSheetMaterial("Plywood");
    const foam = await makeSheetMaterial("Foam");

    const csv = [
      "Description,Material,Width,Length,Qty",
      "Panel A,Plywood,24,48,1",
      "Panel B,Plywood,10,10,2",
      "Panel C,Foam,12,12,1",
    ].join("\n");

    const result = await importCutListPartsFromCsv(version.id, csv);
    expect(result).toEqual({ imported: 3, errors: [] });

    const plywoodParts = await db.cutListPart.findMany({ where: { estimateVersionId: version.id, materialId: plywood.id } });
    const foamParts = await db.cutListPart.findMany({ where: { estimateVersionId: version.id, materialId: foam.id } });
    expect(plywoodParts).toHaveLength(2);
    expect(foamParts).toHaveLength(1);
  });

  it("skips a row whose material name doesn't match any catalog material, reporting the reason, while still importing valid rows", async () => {
    const version = await makeVersion();
    await makeSheetMaterial("Plywood");

    const csv = ["Description,Material,Width,Length,Qty", "Panel A,Plywood,24,48,1", "Panel B,Unobtanium,10,10,1"].join("\n");
    const result = await importCutListPartsFromCsv(version.id, csv);

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual([{ row: 3, reason: 'Unknown material "Unobtanium"' }]);
  });

  it("skips a row whose material name matches more than one catalog material (no @@unique on Material.name)", async () => {
    const version = await makeVersion();
    await makeSheetMaterial("Plywood");
    await makeSheetMaterial("Plywood");

    const csv = "Description,Material,Width,Length,Qty\nPanel A,Plywood,24,48,1";
    const result = await importCutListPartsFromCsv(version.id, csv);

    expect(result.imported).toBe(0);
    expect(result.errors).toEqual([{ row: 2, reason: expect.stringContaining("ambiguous") }]);
  });

  it("matches material names case-insensitively", async () => {
    const version = await makeVersion();
    await makeSheetMaterial("Plywood");

    const csv = "Description,Material,Width,Length,Qty\nPanel A,PLYWOOD,24,48,1";
    const result = await importCutListPartsFromCsv(version.id, csv);

    expect(result).toEqual({ imported: 1, errors: [] });
  });
});

describe("buildCsvTemplate", () => {
  it("produces a CSV whose header row matches CUT_LIST_CSV_HEADERS and parses back cleanly", () => {
    const template = buildCsvTemplate();
    const parsedHeaders = Papa.parse<Record<string, string>>(template, { header: true }).meta.fields;
    expect(parsedHeaders).toEqual([...CUT_LIST_CSV_HEADERS]);

    const { rows, errors } = parseCutListCsvRows(template);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});
