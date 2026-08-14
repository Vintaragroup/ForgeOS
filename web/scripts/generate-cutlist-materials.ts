// One-off generator: reads the real CutList Plus export in
// data/Catalog_Data/cut-list_data/ (this shop's own actual material
// library) and writes prisma/seed-data/cutlist-materials.ts as literal
// TS arrays -- same bridge-from-local-CSV-to-committed-file shape as
// scripts/generate-catalog-expansion.ts, reusing its own CSV parser
// directly since this is the identical RFC4180 format.
//
// Not run automatically -- data/Catalog_Data/ is local-only (gitignored),
// same reasoning as catalog-expansion's own header comment.
//
// Only "(Sheet Goods)" and "(Dimensioned Lumber)" sections are pulled --
// these are the two types cut-list-nesting-service.ts's MaterialType
// enum actually models (SHEET/LINEAR). "(Rough Lumber)" is deliberately
// skipped: it's priced by Cubic Ft. (unprocessed stock, no fixed
// board/sheet size), which doesn't map onto either type this feature's
// nesting engine uses.
//
// Run with: npx tsx scripts/generate-cutlist-materials.ts

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data/Catalog_Data/cut-list_data");
const CSV_FILE = path.join(DATA_DIR, "Cutlistplus_estimating_database_081426.csv");
const OUT_FILE = path.resolve(import.meta.dirname, "../prisma/seed-data/cutlist-materials.ts");

// Identical to generate-catalog-expansion.ts's own parser -- same file
// format, no reason for a second implementation.
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
  return rows;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isBlankRow(row: string[]): boolean {
  return row.every((c) => c.trim() === "");
}

// "1/8"" -> 0.125, "3 1/2"" -> 3.5, "48"" -> 48. Whole-number-plus-
// fraction inch notation is the only format either section uses.
function parseInches(raw: string): number | null {
  const s = raw.replace(/"/g, "").trim();
  if (!s) return null;
  let total = 0;
  for (const part of s.split(/\s+/).filter(Boolean)) {
    if (part.includes("/")) {
      const [num, den] = part.split("/").map(Number);
      if (!den) return null;
      total += num / den;
    } else {
      const n = Number(part);
      if (Number.isNaN(n)) return null;
      total += n;
    }
  }
  return total;
}

function parseCost(raw: string): number | null {
  const n = Number(raw.replace(/[$,]/g, "").trim());
  return Number.isNaN(n) ? null : n;
}

export interface CutlistSeedMaterial {
  name: string;
  category: string;
  materialType: "SHEET" | "LINEAR";
  stockWidth: number | null;
  stockLength: number;
  thickness: number;
  currentUnitCost: number;
  sourceNote: string;
}

interface Group {
  baseName: string;
  type: "Sheet Goods" | "Dimensioned Lumber";
  header: string[];
  rows: string[][];
}

const TITLE_RE = /^(.+?) \((Sheet Goods|Dimensioned Lumber)\)$/;

function parseGroups(rows: string[][]): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let awaitingHeader = false;

  for (const row of rows) {
    const first = (row[0] ?? "").trim();
    const titleMatch = first.match(TITLE_RE);
    if (titleMatch && (row.length === 1 || row.slice(1).every((c) => c.trim() === ""))) {
      current = { baseName: titleMatch[1], type: titleMatch[2] as Group["type"], header: [], rows: [] };
      groups.push(current);
      awaitingHeader = true;
      continue;
    }
    if (!current) continue;
    if (isBlankRow(row)) {
      current = null;
      continue;
    }
    if (awaitingHeader) {
      current.header = row.map((c) => c.trim());
      awaitingHeader = false;
      continue;
    }
    current.rows.push(row);
  }
  return groups;
}

function colIndex(header: string[], name: string): number {
  const i = header.indexOf(name);
  if (i === -1) throw new Error(`Column "${name}" not found in header: ${header.join(" | ")}`);
  return i;
}

function buildSheetGoodsMaterials(group: Group): CutlistSeedMaterial[] {
  const thickI = colIndex(group.header, "Actual Thick.");
  const widthI = colIndex(group.header, "Width");
  const lengthI = colIndex(group.header, "Length");
  const costI = colIndex(group.header, "Unit Cost");
  const vendorI = colIndex(group.header, "Vendor");
  const notesI = colIndex(group.header, "Notes");

  const parsed = group.rows.map((r) => ({
    thickness: parseInches(r[thickI] ?? ""),
    width: parseInches(r[widthI] ?? ""),
    length: parseInches(r[lengthI] ?? ""),
    cost: parseCost(r[costI] ?? ""),
    vendor: (r[vendorI] ?? "").trim(),
    notes: (r[notesI] ?? "").trim(),
  }));

  const multiple = parsed.length > 1;
  return parsed.flatMap((p) => {
    if (p.thickness == null || p.width == null || p.length == null || p.cost == null) return [];
    const name = multiple
      ? `${group.baseName} (${p.thickness}" x ${p.width}x${p.length})`
      : group.baseName;
    const provenance = [
      "Real: this shop's own CutList Plus material library export.",
      p.vendor ? `Vendor: ${p.vendor}.` : null,
      p.notes ? `Notes: ${p.notes}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return [
      {
        name,
        category: "Wood & Sheet Goods",
        materialType: "SHEET" as const,
        stockWidth: p.width,
        stockLength: p.length,
        thickness: p.thickness,
        currentUnitCost: p.cost,
        sourceNote: provenance,
      },
    ];
  });
}

function buildDimensionedLumberMaterials(group: Group): CutlistSeedMaterial[] {
  const thickI = colIndex(group.header, "Actual Thick.");
  const lengthI = colIndex(group.header, "Length");
  const costI = colIndex(group.header, "Unit Cost");
  const vendorI = colIndex(group.header, "Vendor");
  const notesI = colIndex(group.header, "Notes");

  const parsed = group.rows.map((r) => ({
    thickness: parseInches(r[thickI] ?? ""),
    length: parseInches(r[lengthI] ?? ""),
    cost: parseCost(r[costI] ?? ""),
    vendor: (r[vendorI] ?? "").trim(),
    notes: (r[notesI] ?? "").trim(),
  }));

  const multiple = parsed.length > 1;
  return parsed.flatMap((p) => {
    if (p.thickness == null || p.length == null || p.cost == null) return [];
    const name = multiple ? `${group.baseName} (${p.thickness}" x ${p.length}L)` : group.baseName;
    const provenance = [
      "Real: this shop's own CutList Plus material library export.",
      p.vendor ? `Vendor: ${p.vendor}.` : null,
      p.notes ? `Notes: ${p.notes}.` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return [
      {
        name,
        category: "Dimensioned Lumber",
        materialType: "LINEAR" as const,
        stockWidth: null,
        stockLength: p.length,
        thickness: p.thickness,
        currentUnitCost: p.cost,
        sourceNote: provenance,
      },
    ];
  });
}

function format(rows: CutlistSeedMaterial[]): string {
  return rows
    .map(
      (m) =>
        `  { name: "${esc(m.name)}", category: "${esc(m.category)}", materialType: "${m.materialType}", stockWidth: ${m.stockWidth ?? "null"}, stockLength: ${m.stockLength}, thickness: ${m.thickness}, currentUnitCost: ${m.currentUnitCost}, sourceNote: "${esc(m.sourceNote)}" },`,
    )
    .join("\n");
}

function main() {
  const text = readFileSync(CSV_FILE, "utf-8").replace(/^﻿/, "");
  const rows = parseCsv(text);
  const groups = parseGroups(rows);

  const sheetGroups = groups.filter((g) => g.type === "Sheet Goods");
  const lumberGroups = groups.filter((g) => g.type === "Dimensioned Lumber");

  const materials = [
    ...sheetGroups.flatMap(buildSheetGoodsMaterials),
    ...lumberGroups.flatMap(buildDimensionedLumberMaterials),
  ];

  // Names must be globally unique -- prisma/seed.ts upserts by name.
  const seen = new Map<string, number>();
  for (const m of materials) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, count]) => count > 1);
  if (dupes.length > 0) {
    throw new Error(`Duplicate generated material names: ${dupes.map(([n]) => n).join(", ")}`);
  }

  const out = `// GENERATED by scripts/generate-cutlist-materials.ts from
// data/Catalog_Data/cut-list_data/ (local-only, gitignored) -- do not
// hand-edit, regenerate instead. See that script's own header comment
// for provenance/decision notes (why Rough Lumber is excluded, how
// multi-variant names are disambiguated).

export interface CutlistSeedMaterial {
  name: string;
  category: string;
  materialType: "SHEET" | "LINEAR";
  stockWidth: number | null;
  stockLength: number;
  thickness: number;
  currentUnitCost: number;
  sourceNote: string;
}

export const CUTLIST_SEED_MATERIALS: CutlistSeedMaterial[] = [
${format(materials)}
];
`;

  mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, out);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  Sheet Goods groups: ${sheetGroups.length}`);
  console.log(`  Dimensioned Lumber groups: ${lumberGroups.length}`);
  console.log(`  Total materials: ${materials.length}`);
}

main();
