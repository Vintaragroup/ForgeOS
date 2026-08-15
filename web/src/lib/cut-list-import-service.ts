// Cut-list phase 9: bulk-add parts from a CSV file instead of one at a
// time via the Add-a-part form. Uses papaparse (this app's first CSV
// dependency -- no CSV parsing existed anywhere before this) because real
// part descriptions contain commas (e.g. "Custom reception counter,
// lounge and storage components"), so a naive split(",") silently
// corrupts rows; papaparse is RFC4180 quoted-field-aware.
//
// Deliberately NOT the same error posture as addCutListPartAction (which
// aborts on the first bad field): a CSV is a batch of independent rows,
// and one bad line in a 40-row file shouldn't block the other 39. This
// accumulates per-row errors and imports every valid row anyway -- the
// same accumulate-and-report shape optimizeNestingForVersion already
// established for its own per-material skip list.
//
// A missing REQUIRED COLUMN, by contrast, is a whole-file throw (not a
// per-row error) -- that's a structural problem with the file itself,
// same posture addCutListPartAction already uses for a malformed
// request, not something a per-row error list can meaningfully describe.
import Papa from "papaparse";
import { db } from "@/lib/db";
import { clearStaleCutSheets } from "@/lib/cut-list-nesting-service";

export const CUT_LIST_CSV_HEADERS = ["Description", "Material", "Width", "Length", "Qty", "Grain Constrained"] as const;

export interface CutListImportRowError {
  row: number;
  reason: string;
}

export interface CutListImportResult {
  imported: number;
  errors: CutListImportRowError[];
}

interface ParsedCutListRow {
  row: number;
  description: string;
  materialName: string;
  width: number;
  length: number;
  qty: number;
  grainConstrained: boolean;
}

const GRAIN_TRUE_VALUES = new Set(["yes", "true", "1", "x"]);

// header -> normalized key, tolerant of case/spacing/punctuation ("Grain
// Constrained", "grain_constrained", "GRAIN-CONSTRAINED" all match).
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z]/g, "");
}

// Pure, no DB -- directly testable independent of material resolution,
// same "pure function, DB-touching orchestrator calls it" split
// validateManualLayout/updateCutSheetLayoutAction already established.
export function parseCutListCsvRows(csvText: string): { rows: ParsedCutListRow[]; errors: CutListImportRowError[] } {
  const parsed = Papa.parse<Record<string, string>>(csvText, { header: true, skipEmptyLines: true });

  const headerMap = new Map<string, string>();
  for (const field of parsed.meta.fields ?? []) {
    headerMap.set(normalizeHeader(field), field);
  }
  const requiredKeys = { description: "description", material: "material", width: "width", length: "length", qty: "qty" };
  for (const [key, label] of Object.entries(requiredKeys)) {
    if (!headerMap.has(key)) {
      throw new Error(`CSV is missing required column: "${label}". Expected headers: ${CUT_LIST_CSV_HEADERS.join(", ")}`);
    }
  }
  const grainHeader = headerMap.get("grainconstrained");

  const rows: ParsedCutListRow[] = [];
  const errors: CutListImportRowError[] = [];

  parsed.data.forEach((raw, dataIndex) => {
    // +2: 1-indexed, plus the header row itself -- matches the line number
    // a user would see counting rows in Excel/Google Sheets.
    const row = dataIndex + 2;

    const description = String(raw[headerMap.get("description")!] ?? "").trim();
    const materialName = String(raw[headerMap.get("material")!] ?? "").trim();
    const widthRaw = String(raw[headerMap.get("width")!] ?? "").trim();
    const lengthRaw = String(raw[headerMap.get("length")!] ?? "").trim();
    const qtyRaw = String(raw[headerMap.get("qty")!] ?? "").trim();
    const grainRaw = grainHeader ? String(raw[grainHeader] ?? "").trim().toLowerCase() : "";

    if (!description) {
      errors.push({ row, reason: "Description is required" });
      return;
    }
    if (!materialName) {
      errors.push({ row, reason: "Material is required" });
      return;
    }
    const width = Number(widthRaw);
    if (!Number.isFinite(width) || width <= 0) {
      errors.push({ row, reason: `Width must be a positive number (got "${widthRaw}")` });
      return;
    }
    const length = Number(lengthRaw);
    if (!Number.isFinite(length) || length <= 0) {
      errors.push({ row, reason: `Length must be a positive number (got "${lengthRaw}")` });
      return;
    }
    // Blank qty defaults to 1, matching the Add-a-part form's own
    // defaultValue="1" -- a CSV-specific convenience, not present in
    // addCutListPartAction (whose form field always sends a value).
    const qty = qtyRaw === "" ? 1 : Number(qtyRaw);
    if (!Number.isFinite(qty) || qty < 1) {
      errors.push({ row, reason: `Qty must be at least 1 (got "${qtyRaw}")` });
      return;
    }

    rows.push({ row, description, materialName, width, length, qty, grainConstrained: GRAIN_TRUE_VALUES.has(grainRaw) });
  });

  return { rows, errors };
}

// DB orchestrator: parses, resolves each row's material name against the
// same nestable-materials set the Add-a-part dropdown offers, inserts
// every valid row, and clears stale cut sheets once per distinct
// material actually touched -- not once per row, since a 20-row CSV
// against 3 materials should only invalidate those 3 materials' sheets
// once each, the same batching addCutListPartAction gets "for free" by
// only ever touching one material per call.
export async function importCutListPartsFromCsv(estimateVersionId: string, csvText: string): Promise<CutListImportResult> {
  const { rows, errors } = parseCutListCsvRows(csvText);

  const materials = await db.material.findMany({
    where: { deletedAt: null, materialType: "SHEET", stockWidth: { not: null }, stockLength: { not: null } },
    select: { id: true, name: true },
  });
  const materialsByLowerName = new Map<string, { id: string; name: string }[]>();
  for (const material of materials) {
    const key = material.name.toLowerCase();
    const list = materialsByLowerName.get(key) ?? [];
    list.push(material);
    materialsByLowerName.set(key, list);
  }

  const toCreate: { materialId: string; description: string; width: number; length: number; qty: number; grainConstrained: boolean }[] = [];
  for (const row of rows) {
    const matches = materialsByLowerName.get(row.materialName.toLowerCase()) ?? [];
    if (matches.length === 0) {
      errors.push({ row: row.row, reason: `Unknown material "${row.materialName}"` });
      continue;
    }
    // No @@unique on Material.name -- two catalog materials can share a
    // display name (different thickness/size variants, etc.), and a CSV
    // row naming only "Material" has no way to disambiguate them.
    if (matches.length > 1) {
      errors.push({ row: row.row, reason: `Material name "${row.materialName}" is ambiguous (${matches.length} materials share this name)` });
      continue;
    }
    toCreate.push({
      materialId: matches[0].id,
      description: row.description,
      width: row.width,
      length: row.length,
      qty: row.qty,
      grainConstrained: row.grainConstrained,
    });
  }

  if (toCreate.length > 0) {
    await db.cutListPart.createMany({ data: toCreate.map((r) => ({ ...r, estimateVersionId })) });
    const touchedMaterialIds = new Set(toCreate.map((r) => r.materialId));
    for (const materialId of touchedMaterialIds) {
      await clearStaleCutSheets(estimateVersionId, materialId);
    }
  }

  errors.sort((a, b) => a.row - b.row);
  return { imported: toCreate.length, errors };
}

export function buildCsvTemplate(): string {
  return Papa.unparse({
    fields: [...CUT_LIST_CSV_HEADERS],
    data: [["Cabinet side panel", "1\" ethafoam", "24", "48", "2", "yes"]],
  });
}
