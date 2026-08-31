// Cross-checks a CAD Pull Sheet (cad-pull-sheet-service.ts) against its
// matching "DESIGN COST ESTIMATE" Excel quote (design-cost-estimate-
// import-service.ts's readDesignCostRowsForReconciliation) -- a read-only
// audit, not an import. Works Document-to-Document, independent of
// whether/how the Excel has already been imported into an Estimate.
import ExcelJS from "exceljs";
import { getDocumentBytes } from "@/lib/document-service";
import { extractPullSheetRows, type ParsedPullSheetRow } from "@/lib/cad-pull-sheet-service";
import { readDesignCostRowsForReconciliation, type DesignCostReconciliationRow } from "@/lib/design-cost-estimate-import-service";

export type ReconciliationStatus =
  | "MATCHED"
  | "QTY_MISMATCH"
  | "AREA_MISMATCH"
  | "AMBIGUOUS"
  | "ONLY_IN_CAD"
  | "ONLY_IN_EXCEL";

export interface ReconciliationSide {
  label: string; // e.g. "BM6 (x3)" or "row 41"
  qty: number;
  description: string;
  partNumber: string | null;
  areaSqFt: number | null;
}

export interface ReconciliationRow {
  status: ReconciliationStatus;
  cad?: ReconciliationSide;
  excel?: ReconciliationSide;
  detail: string;
}

export type ReconciliationResult =
  | { status: "COMPLETE"; rows: ReconciliationRow[] }
  | { status: "UNSUPPORTED"; reason: string };

// Beyond exact-match range but still worth flagging as "probably the same
// panel, values disagree" rather than "two unrelated missing items" --
// confirmed real panels range roughly 0.3-460 sqft, so a fixed absolute
// band comfortably separates "probably the same panel" from "definitely
// a different one."
const AREA_MISMATCH_MAX = 5;

function normalizePartNumber(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function isWallPanelType(type: string): boolean {
  return type.trim().toLowerCase() === "wall panel";
}

interface PartNumberGroup {
  labels: string[];
  qty: number;
  description: string;
}

function groupCadByPartNumber(rows: ParsedPullSheetRow[]): Map<string, PartNumberGroup> {
  const groups = new Map<string, PartNumberGroup>();
  for (const row of rows) {
    if (!row.partNumber) continue;
    const key = normalizePartNumber(row.partNumber);
    const existing = groups.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.labels.push(row.id);
    } else {
      groups.set(key, { labels: [row.id], qty: row.qty, description: row.description });
    }
  }
  return groups;
}

function groupExcelByPartNumber(rows: DesignCostReconciliationRow[]): Map<string, PartNumberGroup> {
  const groups = new Map<string, PartNumberGroup>();
  for (const row of rows) {
    if (!row.partNumber) continue;
    const key = normalizePartNumber(row.partNumber);
    const existing = groups.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.labels.push(`row ${row.rowNumber}`);
    } else {
      groups.set(key, { labels: [`row ${row.rowNumber}`], qty: row.qty, description: row.description });
    }
  }
  return groups;
}

function reconcilePartNumbers(
  cadRows: ParsedPullSheetRow[],
  excelRows: DesignCostReconciliationRow[],
): ReconciliationRow[] {
  const cadGroups = groupCadByPartNumber(cadRows);
  const excelGroups = groupExcelByPartNumber(excelRows);
  const out: ReconciliationRow[] = [];

  for (const [partNumber, cad] of cadGroups) {
    const cadSide: ReconciliationSide = {
      label: cad.labels.join(", "),
      qty: cad.qty,
      description: cad.description,
      partNumber,
      areaSqFt: null,
    };
    const excel = excelGroups.get(partNumber);
    if (!excel) {
      out.push({
        status: "ONLY_IN_CAD",
        cad: cadSide,
        detail: `Part Number ${partNumber} is on the CAD Pull Sheet (${cad.labels.join(", ")}) but not in the Excel quote.`,
      });
      continue;
    }
    const excelSide: ReconciliationSide = {
      label: excel.labels.join(", "),
      qty: excel.qty,
      description: excel.description,
      partNumber,
      areaSqFt: null,
    };
    if (cad.qty === excel.qty) {
      out.push({ status: "MATCHED", cad: cadSide, excel: excelSide, detail: `Part Number ${partNumber}: qty ${cad.qty} matches.` });
    } else {
      out.push({
        status: "QTY_MISMATCH",
        cad: cadSide,
        excel: excelSide,
        detail: `Part Number ${partNumber}: CAD qty ${cad.qty} vs Excel qty ${excel.qty}.`,
      });
    }
  }

  for (const [partNumber, excel] of excelGroups) {
    if (cadGroups.has(partNumber)) continue;
    out.push({
      status: "ONLY_IN_EXCEL",
      excel: { label: excel.labels.join(", "), qty: excel.qty, description: excel.description, partNumber, areaSqFt: null },
      detail: `Part Number ${partNumber} is in the Excel quote (${excel.labels.join(", ")}) but not on the CAD Pull Sheet.`,
    });
  }

  return out;
}

interface AreaGroup {
  labels: string[];
  qty: number;
  description: string;
  areaSqFt: number;
}

// Rounds to the same 2-decimal precision both sides already transcribe
// Sq. Ft. at -- two physically identical panels (a real, common case: a
// return wall's two faces, or a straight run of matching panels) share
// this exact key on BOTH sides, so they group and cancel out together
// instead of each individual row racing the others for a "nearest"
// pairing that has no real single right answer.
function areaKey(area: number): string {
  return (Math.round(area * 100) / 100).toFixed(2);
}

function groupCadByArea(rows: ParsedPullSheetRow[]): Map<string, AreaGroup> {
  const groups = new Map<string, AreaGroup>();
  for (const row of rows) {
    if (!isWallPanelType(row.type) || row.areaSqFt === null) continue;
    const key = areaKey(row.areaSqFt);
    const existing = groups.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.labels.push(row.id);
    } else {
      groups.set(key, { labels: [row.id], qty: row.qty, description: row.description, areaSqFt: row.areaSqFt });
    }
  }
  return groups;
}

function groupExcelByArea(rows: DesignCostReconciliationRow[]): Map<string, AreaGroup> {
  const groups = new Map<string, AreaGroup>();
  for (const row of rows) {
    if (!isWallPanelType(row.type) || row.sqFt === null) continue;
    const key = areaKey(row.sqFt);
    const existing = groups.get(key);
    if (existing) {
      existing.qty += row.qty;
      existing.labels.push(`row ${row.rowNumber}`);
    } else {
      groups.set(key, { labels: [`row ${row.rowNumber}`], qty: row.qty, description: row.description, areaSqFt: row.sqFt });
    }
  }
  return groups;
}

function reconcileWallPanelAreas(
  cadRows: ParsedPullSheetRow[],
  excelRows: DesignCostReconciliationRow[],
): ReconciliationRow[] {
  const cadGroups = groupCadByArea(cadRows);
  const excelGroups = groupExcelByArea(excelRows);
  const unmatchedExcelKeys = new Set(excelGroups.keys());
  const out: ReconciliationRow[] = [];

  for (const [key, cad] of cadGroups) {
    const cadSide: ReconciliationSide = { label: cad.labels.join(", "), qty: cad.qty, description: cad.description, partNumber: null, areaSqFt: cad.areaSqFt };
    const exact = excelGroups.get(key);
    if (exact) {
      unmatchedExcelKeys.delete(key);
      const excelSide: ReconciliationSide = { label: exact.labels.join(", "), qty: exact.qty, description: exact.description, partNumber: null, areaSqFt: exact.areaSqFt };
      if (cad.qty === exact.qty) {
        out.push({ status: "MATCHED", cad: cadSide, excel: excelSide, detail: `${cad.areaSqFt} sqft: qty ${cad.qty} matches (CAD ${cad.labels.join(", ")} / Excel ${exact.labels.join(", ")}).` });
      } else {
        out.push({
          status: "QTY_MISMATCH",
          cad: cadSide,
          excel: excelSide,
          detail: `${cad.areaSqFt} sqft: CAD qty ${cad.qty} (${cad.labels.join(", ")}) vs Excel qty ${exact.qty} (${exact.labels.join(", ")}).`,
        });
      }
      continue;
    }

    // No exact-area group on the Excel side -- fall back to the nearest
    // still-unmatched Excel group within tolerance, flagged as a
    // discrepancy (not a silent auto-match) since the values disagree.
    const candidates = [...excelGroups.entries()]
      .filter(([excelKey]) => unmatchedExcelKeys.has(excelKey))
      .map(([excelKey, group]) => ({ key: excelKey, group, distance: Math.abs(group.areaSqFt - cad.areaSqFt) }))
      .filter((c) => c.distance <= AREA_MISMATCH_MAX)
      .sort((a, b) => a.distance - b.distance);

    if (candidates.length === 0) {
      out.push({ status: "ONLY_IN_CAD", cad: cadSide, detail: `Panel ${cad.labels.join(", ")} (${cad.areaSqFt} sqft) has no comparable Excel row.` });
      continue;
    }

    const tied = candidates.filter((c) => c.distance === candidates[0].distance);
    if (tied.length > 1) {
      out.push({
        status: "AMBIGUOUS",
        cad: cadSide,
        detail: `Panel ${cad.labels.join(", ")} (${cad.areaSqFt} sqft) is equally close to ${tied.length} different Excel areas (${tied
          .map((t) => `${t.group.areaSqFt} sqft`)
          .join(", ")}) -- resolve manually.`,
      });
      continue;
    }

    const best = candidates[0];
    unmatchedExcelKeys.delete(best.key);
    const excelSide: ReconciliationSide = { label: best.group.labels.join(", "), qty: best.group.qty, description: best.group.description, partNumber: null, areaSqFt: best.group.areaSqFt };
    out.push({
      status: "AREA_MISMATCH",
      cad: cadSide,
      excel: excelSide,
      detail: `Panel ${cad.labels.join(", ")}: closest Excel match is ${best.group.areaSqFt} sqft (${best.group.labels.join(", ")}) vs CAD's ${cad.areaSqFt} sqft.`,
    });
  }

  for (const key of unmatchedExcelKeys) {
    const excel = excelGroups.get(key)!;
    out.push({
      status: "ONLY_IN_EXCEL",
      excel: { label: excel.labels.join(", "), qty: excel.qty, description: excel.description, partNumber: null, areaSqFt: excel.areaSqFt },
      detail: `Excel ${excel.labels.join(", ")} (${excel.areaSqFt} sqft) has no comparable CAD panel.`,
    });
  }

  return out;
}

export async function reconcilePullSheetAgainstExcel(
  cadDocumentId: string,
  excelDocumentId: string,
): Promise<ReconciliationResult> {
  const [{ bytes: cadBytes }, { bytes: excelBytes }] = await Promise.all([
    getDocumentBytes(cadDocumentId),
    getDocumentBytes(excelDocumentId),
  ]);

  const pullSheet = await extractPullSheetRows(cadBytes);
  if (pullSheet.status !== "COMPLETE") {
    return { status: "UNSUPPORTED", reason: pullSheet.reason };
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(excelBytes as unknown as ArrayBuffer);
  const excelRows = await readDesignCostRowsForReconciliation(workbook);
  if (excelRows.length === 0) {
    return { status: "UNSUPPORTED", reason: "No recognizable DESIGN COST ESTIMATE rows found in this workbook." };
  }

  return { status: "COMPLETE", rows: reconcileRows(pullSheet.rows, excelRows) };
}

// Pure matching logic, split out from the Document/byte-loading above so
// it's testable directly against parsed rows with no DB/storage mocking.
export function reconcileRows(
  cadRows: ParsedPullSheetRow[],
  excelRows: DesignCostReconciliationRow[],
): ReconciliationRow[] {
  return [...reconcilePartNumbers(cadRows, excelRows), ...reconcileWallPanelAreas(cadRows, excelRows)];
}
