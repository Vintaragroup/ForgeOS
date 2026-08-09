// Phase 7.1: deterministic parser for the "Pricing Schedule" XLSX shape
// used by real RFP financial proposal exhibits -- see data/RFP/superbowl,
// both packages' Exhibit 1 files share an identical 12-column header
// (Commodity/Category/Item/Description/Unit/Qty/Historical Qty's/
// In-House Inventory/Unit Rate (USD)/Total Price (USD)/Comments/
// Supporting Document Ref) even though the exact wording of "Item" and
// column offsets differ slightly between them. Detection matches header
// TEXT, not filename or exact column position, so this generalizes to
// other clients' similarly-shaped sheets rather than being hardcoded to
// this one template.
//
// Deliberately NOT an AI extraction -- these rows already carry qty and
// description; an LLM would be strictly worse than just reading the cells.

import ExcelJS from "exceljs";
import { getDocumentBytes } from "@/lib/document-service";
import { addLineItemsBulk, addSection } from "@/lib/estimate-service";
import { db } from "@/lib/db";

const HEADER_SCAN_ROWS = 20; // header always appears near the top, after a title/merge block

export interface ParsedPricingRow {
  rowNumber: number;
  category: string;
  item: string | null;
  description: string;
  unit: string;
  qty: number;
}

export interface PricingImportPreview {
  documentId: string;
  filename: string;
  sheetName: string;
  rows: ParsedPricingRow[];
  categories: string[];
}

function normalizeHeader(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "richText" in (value as object)) {
    return (value as { richText: { text: string }[] }).richText.map((r) => r.text).join("");
  }
  return String(value).trim();
}

interface ColumnMap {
  category: number;
  item: number | null;
  description: number;
  unit: number;
  qty: number;
}

// A row counts as THE header row only when category/description/unit/qty
// are all present as distinct columns -- that combination is specific
// enough to a pricing schedule that it won't false-positive on other
// sheets (e.g. the "1. Instructions & Summary" sheet in the same workbook).
function findColumnMap(row: ExcelJS.Row): ColumnMap | null {
  let category: number | null = null;
  let item: number | null = null;
  let description: number | null = null;
  let unit: number | null = null;
  let qty: number | null = null;

  row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = normalizeHeader(cell.value);
    if (text === "category") category = colNumber;
    else if (text === "description") description = colNumber;
    else if (text === "unit") unit = colNumber;
    else if (text === "qty") qty = colNumber;
    else if (item === null && text.startsWith("item")) item = colNumber;
  });

  if (category === null || description === null || unit === null || qty === null) return null;
  return { category, item, description, unit, qty };
}

function findPricingSheet(
  workbook: ExcelJS.Workbook,
): { sheet: ExcelJS.Worksheet; headerRowNumber: number; columns: ColumnMap } | null {
  for (const sheet of workbook.worksheets) {
    for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount); rowNumber++) {
      const columns = findColumnMap(sheet.getRow(rowNumber));
      if (columns) return { sheet, headerRowNumber: rowNumber, columns };
    }
  }
  return null;
}

export async function previewPricingImport(documentId: string): Promise<PricingImportPreview> {
  const { document, bytes } = await getDocumentBytes(documentId);

  const workbook = new ExcelJS.Workbook();
  // exceljs's own Buffer type comes from a slightly different @types/node
  // generation than this project's -- structurally identical at runtime,
  // so this is a type-level mismatch only, not a real conversion.
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const found = findPricingSheet(workbook);
  if (!found) {
    throw new Error(
      `"${document.filename}" doesn't contain a recognizable Pricing Schedule sheet (expected Category/Description/Unit/Qty columns).`,
    );
  }
  const { sheet, headerRowNumber, columns } = found;

  const rows: ParsedPricingRow[] = [];
  let lastCategory = "";
  for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const description = cellText(row.getCell(columns.description).value);
    const qtyRaw = row.getCell(columns.qty).value;
    const qty = typeof qtyRaw === "number" ? qtyRaw : Number(cellText(qtyRaw));

    // A blank description is a spacer row, not a line item. Qty legitimately
    // includes 0 (Exhibit 1's own instructions: "Unit Rates must be
    // provided even where the quantity is zero"), so only NaN disqualifies.
    if (!description || Number.isNaN(qty)) continue;

    const category = cellText(row.getCell(columns.category).value) || lastCategory;
    lastCategory = category;

    rows.push({
      rowNumber,
      category,
      item: columns.item ? cellText(row.getCell(columns.item).value) || null : null,
      description,
      unit: cellText(row.getCell(columns.unit).value),
      qty,
    });
  }

  return {
    documentId,
    filename: document.filename,
    sheetName: sheet.name,
    rows,
    categories: [...new Set(rows.map((r) => r.category))],
  };
}

// Creates one EstimateSection per distinct Category (a real pricing
// schedule collapses ~185 rows into a handful of categories, e.g.
// TemporaryBooth_BUILD/CAMERA_PLATFORM/BOOTH_PLATFORM) and bulk-inserts
// every row as an isDraft LineItem pointing back at the source Document --
// the same review-before-it-counts gate as attachmentId-sourced drafts.
// unitCost starts at 0: the Pricing Schedule's own Unit Rate column is
// blank by design (that's the bidder's job to fill in), not something to
// guess at.
export async function commitPricingImport(estimateVersionId: string, documentId: string) {
  const preview = await previewPricingImport(documentId);
  if (preview.rows.length === 0) {
    throw new Error(`No line items found in "${preview.filename}".`);
  }

  const existingSectionCount = await db.estimateSection.count({
    where: { estimateVersionId, optionId: null },
  });

  let nextSortOrder = existingSectionCount;
  const created = [];
  for (const category of preview.categories) {
    const section = await addSection(estimateVersionId, {
      name: category,
      sectionType: "CATEGORY",
      sortOrder: nextSortOrder++,
    });

    const rowsForCategory = preview.rows.filter((r) => r.category === category);
    const lineItems = await addLineItemsBulk(
      estimateVersionId,
      section.id,
      rowsForCategory.map((row) => ({
        lineType: "MATERIAL" as const,
        description: row.item ? `${row.item} — ${row.description}` : row.description,
        qty: row.qty,
        unitCost: 0,
        documentId,
      })),
    );
    created.push({ section, count: lineItems.length });
  }

  return { filename: preview.filename, sectionsCreated: created.length, rowsImported: preview.rows.length };
}
