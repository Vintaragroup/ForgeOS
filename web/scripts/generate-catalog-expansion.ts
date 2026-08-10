// One-off generator: reads the real extraction CSVs in
// data/Catalog_Data/Materials_pulled_from_groundtruth/ and the BeMatrix
// vendor price file in data/Catalog_Data/B-Matrix/, and writes
// prisma/seed-data/catalog-expansion.ts as literal TS arrays.
//
// Not run automatically -- data/Catalog_Data/ is local-only (gitignored,
// not committed), so prisma/seed.ts must not depend on reading it at
// seed time, same reasoning as the original MATERIALS/RENTAL_ITEMS
// arrays already hardcoded there. This script is the one-time bridge
// from that local folder to a committed, reproducible TS file.
//
// Run with: npx tsx scripts/generate-catalog-expansion.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

const DATA_DIR = path.resolve(
  import.meta.dirname,
  "../../data/Catalog_Data",
);
const CSV_DIR = path.join(DATA_DIR, "Materials_pulled_from_groundtruth");
const BEMATRIX_XLSX = path.join(DATA_DIR, "B-Matrix", "BeMAtrix Frames & Accessories Purchase Price 2.xlsx");
const OUT_FILE = path.resolve(import.meta.dirname, "../prisma/seed-data/catalog-expansion.ts");

// Minimal RFC4180 CSV parser -- handles quoted fields with embedded
// commas/newlines and "" escaped quotes, which is all these files use.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (c === "\r") {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

function readCsv(filename: string): Record<string, string>[] {
  const text = readFileSync(path.join(CSV_DIR, filename), "utf-8").replace(/^\uFEFF/, "");
  const [header, ...rows] = parseCsv(text);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------- Materials (materials_master.csv) ----------
// The source has no category column -- hand-reviewed every one of the 49
// rows and grouped them under this app's existing Material category
// names (see prisma/seed.ts) plus 3 new ones (Electrical, Laminate &
// Finishes, Packing & Crating, Miscellaneous) where nothing existing fit.
const MATERIAL_CATEGORY_BY_ID: Record<string, string> = {
  "MAT-0001": "Printing Substrates", "MAT-0002": "Printing Substrates", "MAT-0003": "Printing Substrates",
  "MAT-0004": "Printing Substrates", "MAT-0005": "Printing Substrates", "MAT-0006": "Printing Substrates",
  "MAT-0010": "Printing Substrates", "MAT-0011": "Printing Substrates", "MAT-0038": "Printing Substrates",
  "MAT-0039": "Printing Substrates", "MAT-0040": "Printing Substrates", "MAT-0041": "Printing Substrates",
  "MAT-0042": "Printing Substrates", "MAT-0043": "Printing Substrates", "MAT-0044": "Printing Substrates",
  "MAT-0045": "Printing Substrates", "MAT-0046": "Printing Substrates", "MAT-0049": "Printing Substrates",
  "MAT-0047": "Printing Substrates",
  "MAT-0007": "Acrylic", "MAT-0008": "Acrylic", "MAT-0009": "Acrylic", "MAT-0013": "Acrylic",
  "MAT-0014": "Acrylic", "MAT-0015": "Acrylic", "MAT-0016": "Acrylic", "MAT-0017": "Acrylic", "MAT-0018": "Acrylic",
  "MAT-0012": "Hardware & Fasteners", "MAT-0022": "Hardware & Fasteners", "MAT-0023": "Hardware & Fasteners",
  "MAT-0024": "Hardware & Fasteners", "MAT-0025": "Hardware & Fasteners", "MAT-0026": "Hardware & Fasteners",
  "MAT-0019": "Packing & Crating", "MAT-0048": "Packing & Crating",
  "MAT-0020": "Electrical", "MAT-0021": "Electrical",
  "MAT-0027": "Laminate & Finishes", "MAT-0028": "Laminate & Finishes", "MAT-0029": "Laminate & Finishes",
  "MAT-0030": "Laminate & Finishes", "MAT-0031": "Laminate & Finishes",
  "MAT-0032": "Miscellaneous", "MAT-0033": "Miscellaneous",
  "MAT-0034": "Wood & Sheet Goods", "MAT-0035": "Wood & Sheet Goods", "MAT-0036": "Wood & Sheet Goods",
  "MAT-0037": "Wood & Sheet Goods",
};

// The only real price conflict in materials_master.csv: MISC at $0
// (61 sources, a free-entry placeholder) vs $10 (1 source: COMPONENT 2).
// Per the higher-price-wins rule, kept at $10 -- MAT-0032 ($0) is dropped.
const MATERIAL_ROW_OVERRIDE_SKIP = new Set(["MAT-0032"]);
const MATERIAL_CONFLICT_NOTES: Record<string, string> = {
  "MAT-0033": "Price conflict in the source extraction: $0 in 61 sources (a free-entry placeholder for unspecified misc cost) vs $10 in 1 source (COMPONENT 2 sheet). Kept the priced ($10) value per the higher-price-wins rule -- verify against real usage before relying on this for a real misc line.",
};

interface MaterialRow {
  category: string;
  name: string;
  unit: string | null;
  currentUnitCost: number;
  sourceNote: string;
}

function buildMaterialsFromMaster(): MaterialRow[] {
  const rows = readCsv("materials_master.csv");
  const out: MaterialRow[] = [];
  for (const r of rows) {
    const id = r.material_id;
    if (MATERIAL_ROW_OVERRIDE_SKIP.has(id)) continue;
    const category = MATERIAL_CATEGORY_BY_ID[id];
    if (!category) throw new Error(`No category mapped for ${id} (${r.material_name})`);
    const note =
      MATERIAL_CONFLICT_NOTES[id] ??
      `Real: extracted from ${r.source_count} historical job component sheet(s) (primary: ${r.primary_source_sheet}, row ${r.primary_source_row}).`;
    out.push({
      category,
      name: r.material_name,
      unit: null,
      currentUnitCost: Number(r.unit_cost),
      sourceNote: note,
    });
  }
  return out;
}

// ---------- Rentals (rentals_master.csv) ----------
const RENTAL_CATEGORY_TIDY: Record<string, string> = {
  Accessories: "Accessories",
  AV: "A/V",
  Flooring: "Flooring",
  Furniture: "Furniture",
  "Hanging Sign": "Hanging Sign",
  Structure: "Structure",
};

// The 2 real price conflicts in rentals_master.csv. Both kept at the
// higher price with an explanatory note; the lower-priced duplicate row
// is dropped.
const RENTAL_ROW_OVERRIDE_SKIP = new Set(["RENT-0020", "RENT-0040"]);
const RENTAL_CONFLICT_NOTES: Record<string, string> = {
  "RENT-0021":
    "Price conflict in the source extraction: this item appeared as $0 (Accessories row 18, apparently never priced) and $32.34 (row 17, a real price). Kept the priced ($32.34) value.",
  "RENT-0041":
    "Price conflict in the source extraction: this item appeared at $250 (Furniture row 10) and $350 (row 11). Kept the higher ($350) value pending verification against current supplier rate.",
};

interface RentalRow {
  category: string;
  name: string;
  unitPrice: number;
  note: string;
}

function buildRentalsFromMaster(): RentalRow[] {
  const rows = readCsv("rentals_master.csv");
  const out: RentalRow[] = [];
  for (const r of rows) {
    const id = r.rental_id;
    if (RENTAL_ROW_OVERRIDE_SKIP.has(id)) continue;
    const category = RENTAL_CATEGORY_TIDY[r.category] ?? r.category;
    const note =
      RENTAL_CONFLICT_NOTES[id] ??
      `Real: extracted from the ${r.source_sheet} rental tab (${r.source_count} source record(s)).`;
    out.push({ category, name: r.item_name, unitPrice: Number(r.unit_price), note });
  }
  return out;
}

// ---------- standard_costs.csv: only the categories NOT already in the
// existing 9-item RentalItem seed (Flooring/Hanging-Sign(existing)/
// Frames/Slatwalls/Doors/Stem-Lights/Shelves/Pedestals/Warehouse-Labor).
// Per decision: Design Time stays one row per booth size/complexity
// rather than collapsing to a flat rate.
const STANDARD_COSTS_CATEGORY_MAP: Record<string, string> = {
  "RENTAL FURNITURE": "Furniture (Standard Rate)",
  "RENTAL A/V": "A/V (Standard Rate)",
  "GRAPHICS PACKAGE": "Graphics Package",
  "DESIGN TIME": "Design Time",
  Shipping: "Shipping",
};

function buildRentalsFromStandardCosts(): RentalRow[] {
  const rows = readCsv("standard_costs.csv");
  const out: RentalRow[] = [];
  for (const r of rows) {
    const category = STANDARD_COSTS_CATEGORY_MAP[r.category];
    if (!category) continue; // already-seeded RENTAL STRUCTURE / RENTAL FLOORING & PADDING / HANGING SIGN categories
    out.push({
      category,
      name: r.item_name,
      unitPrice: Number(r.standard_price),
      note: `Real: Standard Cost Sheet, a generic per-size/complexity reference rate (row ${r.source_row}) -- distinct from the itemized real rental SKUs in this same category's non-"Standard Rate" entries.`,
    });
  }
  return out;
}

// ---------- Labor rates (labor_rates_show_site.csv) ----------
// Straight-time rate only for this pass -- the model has one rate field,
// not ST/OT/DT; revisit if overtime/double-time needs to drive estimate
// math later.
interface LaborRow {
  city: string;
  rate: number;
  note: string;
}

function buildShowSiteLaborRates(): LaborRow[] {
  const rows = readCsv("labor_rates_show_site.csv");
  const out: LaborRow[] = [];
  for (const r of rows) {
    const st = Number(r.st_rate);
    if (!r.st_rate || Number.isNaN(st)) continue;
    out.push({
      city: r.city_market,
      rate: st,
      note: `Real: Show-site labor rate table, straight-time only (OT $${r.ot_rate || "?"}${r.dt_rate ? `, DT $${r.dt_rate}` : ""} not yet modeled). ${r.travel_required ? r.travel_required + "." : ""}`.trim(),
    });
  }
  return out;
}

// ---------- BeMatrix vendor price file ----------
async function buildBeMatrix(): Promise<{ materials: MaterialRow[]; rentals: RentalRow[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(BEMATRIX_XLSX);

  const cellText = (v: unknown): string => {
    if (v && typeof v === "object" && "richText" in v) {
      return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    }
    return String(v ?? "").trim();
  };
  const cellNumber = (v: unknown): number => {
    if (v && typeof v === "object" && "result" in v) return Number((v as { result: unknown }).result);
    return Number(v);
  };

  const materials: MaterialRow[] = [];
  const frames = wb.getWorksheet("Frames")!;
  for (let r = 6; r <= frames.rowCount; r++) {
    const row = frames.getRow(r);
    const code = cellText(row.getCell(1).value);
    const name = cellText(row.getCell(2).value);
    const price = cellNumber(row.getCell(4).value);
    if (!name || Number.isNaN(price)) continue;
    materials.push({
      category: "BeMatrix System",
      name,
      unit: null,
      currentUnitCost: price,
      sourceNote: `Real: BeMatrix vendor purchase price list, part ${code}.`,
    });
  }

  const rentals: RentalRow[] = [];
  const accessories = wb.getWorksheet("Accessories")!;
  for (let r = 8; r <= accessories.rowCount; r++) {
    const row = accessories.getRow(r);
    const code = cellText(row.getCell(1).value);
    const name = cellText(row.getCell(2).value);
    const price = cellNumber(row.getCell(4).value);
    if (!name || Number.isNaN(price)) continue;
    rentals.push({
      category: "BeMatrix System",
      name,
      unitPrice: price,
      note: `Real: BeMatrix vendor "Accessories Rental Price" sheet, part ${code}.`,
    });
  }

  return { materials, rentals };
}

function formatMaterials(rows: MaterialRow[]): string {
  return rows
    .map(
      (m) =>
        `  { category: "${esc(m.category)}", name: "${esc(m.name)}", unit: ${m.unit ? `"${esc(m.unit)}"` : "null"}, currentUnitCost: ${m.currentUnitCost}, sourceNote: "${esc(m.sourceNote)}" },`,
    )
    .join("\n");
}

function formatRentals(rows: RentalRow[]): string {
  return rows
    .map(
      (r) =>
        `  { category: "${esc(r.category)}", name: "${esc(r.name)}", unitPrice: ${r.unitPrice}, note: "${esc(r.note)}" },`,
    )
    .join("\n");
}

function formatLabor(rows: LaborRow[]): string {
  return rows.map((l) => `  { city: "${esc(l.city)}", rate: ${l.rate}, note: "${esc(l.note)}" },`).join("\n");
}

async function main() {
  const materials = buildMaterialsFromMaster();
  const rentals = [...buildRentalsFromMaster(), ...buildRentalsFromStandardCosts()];
  const labor = buildShowSiteLaborRates();
  const beMatrix = await buildBeMatrix();

  const allMaterials = [...materials, ...beMatrix.materials];
  const allRentals = [...rentals, ...beMatrix.rentals];

  const out = `// GENERATED by scripts/generate-catalog-expansion.ts from
// data/Catalog_Data/ (local-only, gitignored) -- do not hand-edit, regenerate instead.
// See that script's own header comment for provenance/decision notes.

export interface ExpansionMaterial {
  category: string;
  name: string;
  unit: string | null;
  currentUnitCost: number;
  sourceNote: string;
}

export interface ExpansionRentalItem {
  category: string;
  name: string;
  unitPrice: number;
  note: string;
}

export interface ExpansionLaborRate {
  city: string;
  rate: number;
  note: string;
}

export const CATALOG_EXPANSION_MATERIALS: ExpansionMaterial[] = [
${formatMaterials(allMaterials)}
];

export const CATALOG_EXPANSION_RENTAL_ITEMS: ExpansionRentalItem[] = [
${formatRentals(allRentals)}
];

export const CATALOG_EXPANSION_LABOR_RATES: ExpansionLaborRate[] = [
${formatLabor(labor)}
];
`;

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, out);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  Materials: ${allMaterials.length} (${materials.length} from master + ${beMatrix.materials.length} BeMatrix)`);
  console.log(`  Rentals: ${allRentals.length} (${rentals.length} from master/standard-costs + ${beMatrix.rentals.length} BeMatrix)`);
  console.log(`  Labor rates: ${labor.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
