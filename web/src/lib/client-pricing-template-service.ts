// The CLIENT's own RFP pricing template (e.g. "Exhibit 1 - SBLXI - Financial
// Proposal Schedule..."), read-only -- this is the tender response document
// the client wants back with Unit Rates filled in, not something we import
// as our own line items. Confirmed live against the real file
// (data/RFP/superbowl/RFP006 - Temporary Booth Build/Exhibit 1 -
// SBLXI - Financial Proposal Schedule Temporary Booth Build.xlsx, sheet
// "2. Pricing Schedule"): one block per booth Section (each row's own
// "Item" column carries the Section label, e.g. "Section 401 - Booth -
// Page 9"), a standalone "ADD ONS / RATE CARD" block with no Section of
// its own, then "Total" and "VARIATIONS" markers where structured data
// ends.
//
// Deliberately does NOT create LineItems or suggest Unit Rates -- the
// client's line items ("Complete Booth Build", "FR Carpet") are far
// coarser than the vendor-engineered booth workbooks this app already
// imports (BeMatrix frame parts, wall-panel dimensions to the inch), and
// there's no reliable boundary to split our part-level costs back into
// their bucket-level ones. This is a read-only coverage check: per
// Section, does our imported pricing look like it actually covers what
// the client is asking for.

import ExcelJS from "exceljs";
import { Prisma } from "@/generated/prisma/client";
import { getDocumentBytes } from "@/lib/document-service";
import { computeLineItemTotal } from "@/lib/estimate-service";
import { db } from "@/lib/db";
import { cellText } from "@/lib/xlsx-utils";

const HEADER_SCAN_ROWS = 15;

export interface ClientTemplateRow {
  rowNumber: number;
  section: string | null; // e.g. "SECTION 401", normalized the same way EstimateSection.groupLabel is; null for ADD ONS / RATE CARD rows, which aren't tied to a Section
  description: string;
  unit: string;
  qty: number;
  isAddOn: boolean;
}

// Distinctive enough (both "Unit Rate (USD)" AND "Total Price (USD)" as
// column headers) that this never collides with either of this app's own
// two importer shapes -- pricing-import-service.ts's flat schedule never
// has a Unit Rate column (that's the BIDDER's job, not the schedule's),
// and design-cost-estimate-import-service.ts's "Qty/Type/Sq. Ft./
// Description/Unit Cost/..." header never says "Unit Rate" or has a
// client-facing "Total Price" column either.
export function detectClientPricingTemplateSheet(sheet: ExcelJS.Worksheet): boolean {
  for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount); rowNumber++) {
    const row = sheet.getRow(rowNumber);
    let hasUnitRate = false;
    let hasTotalPrice = false;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const text = cellText(cell.value).trim().toLowerCase();
      if (text === "unit rate (usd)") hasUnitRate = true;
      if (text === "total price (usd)") hasTotalPrice = true;
    });
    if (hasUnitRate && hasTotalPrice) return true;
  }
  return false;
}

export function findClientPricingTemplateSheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet | null {
  for (const sheet of workbook.worksheets) {
    if (detectClientPricingTemplateSheet(sheet)) return sheet;
  }
  return null;
}

function findHeaderRow(
  sheet: ExcelJS.Worksheet,
): { rowNumber: number; commodityCol: number; itemCol: number; descCol: number; unitCol: number; qtyCol: number } | null {
  for (let rowNumber = 1; rowNumber <= Math.min(HEADER_SCAN_ROWS, sheet.rowCount); rowNumber++) {
    const row = sheet.getRow(rowNumber);
    let commodityCol: number | null = null;
    let itemCol: number | null = null;
    let descCol: number | null = null;
    let unitCol: number | null = null;
    let qtyCol: number | null = null;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      const text = cellText(cell.value).trim().toLowerCase();
      if (text === "commodity") commodityCol = colNumber;
      else if (itemCol === null && text.startsWith("item")) itemCol = colNumber;
      else if (text === "description") descCol = colNumber;
      else if (text === "unit") unitCol = colNumber;
      else if (text === "qty") qtyCol = colNumber;
    });
    if (itemCol !== null && descCol !== null && unitCol !== null && qtyCol !== null) {
      return { rowNumber, commodityCol: commodityCol ?? itemCol - 1, itemCol, descCol, unitCol, qtyCol };
    }
  }
  return null;
}

function numericOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = cellText(value);
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// Parses everything from just below the header down through the
// per-Section blocks and the standalone "ADD ONS / RATE CARD" block,
// stopping at "Total" (the auto-computed grand total row) -- "VARIATIONS"
// below that is free-form, tenderer-added content with no fixed shape,
// out of scope for a structured parse.
export function parseClientPricingTemplate(sheet: ExcelJS.Worksheet): ClientTemplateRow[] {
  const header = findHeaderRow(sheet);
  if (!header) return [];

  const rows: ClientTemplateRow[] = [];
  let inAddOnBlock = false;
  for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    const commodityText = cellText(row.getCell(header.commodityCol).value).trim();

    if (commodityText === "Total") break;
    if (commodityText === "VARIATIONS") break;
    if (commodityText === "ADD ONS / RATE CARD") {
      inAddOnBlock = true;
      continue;
    }

    const qty = numericOrNull(row.getCell(header.qtyCol).value);
    if (qty === null) continue; // spacer row, or a banner this loop doesn't otherwise recognize

    const itemText = cellText(row.getCell(header.itemCol).value).trim();
    const descText = cellText(row.getCell(header.descCol).value).trim();
    // The per-Section blocks carry the Section label in the Item column
    // and the real item text in Description; the ADD ONS block has no
    // Section, so its real item text sits in Item instead and
    // Description is blank -- confirmed against both real blocks, this
    // fallback (prefer Description, fall back to Item) covers both
    // without a separate code path.
    const description = descText || itemText;
    if (!description) continue;

    const unit = cellText(row.getCell(header.unitCol).value).trim();
    const sectionMatch = itemText.match(/SECTION\s+\d+/i);
    const section = sectionMatch ? sectionMatch[0].replace(/\s+/g, " ").toUpperCase() : null;

    rows.push({ rowNumber, section, description, unit, qty, isAddOn: inAddOnBlock });
  }
  return rows;
}

export interface SectionReconciliation {
  section: string;
  clientItems: { description: string; unit: string; qty: number }[];
  ourTotal: Prisma.Decimal;
  ourItemCount: number;
  ourCategories: string[];
  missingSection: boolean;
  categoryGaps: string[];
}

export interface ClientTemplateReconciliation {
  documentId: string;
  filename: string;
  sections: SectionReconciliation[];
  addOnRows: { description: string; unit: string; qty: number }[];
}

// Read-only: loads the client template + this version's own LineItems and
// compares them by Section, never writes anything. Deliberately sums
// EVERY LineItem regardless of isDraft -- unlike the version's own
// official total (estimate-service.ts's computeSectionTotal, which
// excludes drafts until confirmed), this is a coverage check against what
// has actually been priced so far, not the contract-ready total.
export async function reconcileAgainstClientTemplate(
  estimateVersionId: string,
  documentId: string,
): Promise<ClientTemplateReconciliation> {
  const version = await db.estimateVersion.findUniqueOrThrow({
    where: { id: estimateVersionId },
    select: {
      estimate: { select: { opportunityId: true } },
      sections: {
        where: { optionId: null },
        select: { groupLabel: true, lineItems: { select: { description: true, category: true, qty: true, unitCost: true } } },
      },
    },
  });

  const { document, bytes } = await getDocumentBytes(documentId);
  if (document.opportunityId !== version.estimate.opportunityId) {
    throw new Error("This document doesn't belong to this opportunity.");
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = findClientPricingTemplateSheet(workbook);
  if (!sheet) {
    throw new Error(`"${document.filename}" doesn't look like the client's RFP pricing template.`);
  }
  const rows = parseClientPricingTemplate(sheet);

  const bySection = new Map<string, ClientTemplateRow[]>();
  const addOnRows: ClientTemplateRow[] = [];
  for (const row of rows) {
    if (row.isAddOn) {
      addOnRows.push(row);
      continue;
    }
    if (!row.section) continue;
    if (!bySection.has(row.section)) bySection.set(row.section, []);
    bySection.get(row.section)!.push(row);
  }

  const sections: SectionReconciliation[] = [];
  for (const [section, clientItems] of bySection) {
    const ourLineItems = version.sections.filter((s) => s.groupLabel === section).flatMap((s) => s.lineItems);
    const ourTotal = ourLineItems.reduce((sum, li) => sum.plus(computeLineItemTotal(li.qty, li.unitCost)), new Prisma.Decimal(0));
    const ourCategories = [...new Set(ourLineItems.map((li) => li.category).filter((c): c is string => !!c))];

    const categoryGaps: string[] = [];
    if (clientItems.some((r) => /carpet|roof|platform|sleeper floor/i.test(r.description)) && !ourCategories.includes("Flooring")) {
      categoryGaps.push(
        "Client expects flooring-related items (carpet, roof, platform, or sleeper floor) but no Flooring-category line items are priced for this section.",
      );
    }
    if (
      clientItems.some((r) => /\bdoor\b/i.test(r.description)) &&
      !ourLineItems.some((li) => /\bdoor\b/i.test(li.description))
    ) {
      categoryGaps.push("Client expects a door but no line item description mentions one for this section.");
    }

    sections.push({
      section,
      clientItems: clientItems.map((r) => ({ description: r.description, unit: r.unit, qty: r.qty })),
      ourTotal,
      ourItemCount: ourLineItems.length,
      ourCategories,
      missingSection: ourLineItems.length === 0,
      categoryGaps,
    });
  }
  sections.sort((a, b) => a.section.localeCompare(b.section));

  return {
    documentId,
    filename: document.filename,
    sections,
    addOnRows: addOnRows.map((r) => ({ description: r.description, unit: r.unit, qty: r.qty })),
  };
}
