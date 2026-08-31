// Deterministic parser for the "PULL SHEET" table AutoCAD exports on the
// last page of a booth CAD PDF (confirmed live against 13 real files in
// data/RFP/superbowl/RFP006 - Temporary Booth Build/Vendor-pricing-engineering/CAD-files).
//
// text-extraction.ts's own comment says DRAWING PDFs "aren't text-
// extractable" -- true for the normal page.getTextContent() path (which
// only sees the title-block's real font text, never the table), but NOT
// the whole story: AutoCAD renders its SHX-font table text as PDF
// annotations, not body text. page.getAnnotations() returns one entry per
// character run, each carrying titleObj.str === "AutoCAD SHX Text", a
// position (rect), and the real text (contentsObj.str). Grouping those by
// y-position into rows and by x-position (anchored to the header row's own
// column positions) into columns reconstructs the exact table -- confirmed
// against real BeMatrix Part Numbers and real Wall Panel Area (SqFt)
// values, both matching their Excel counterparts precisely.
import { getDocumentProxy, extractText } from "unpdf";

export interface ParsedPullSheetRow {
  id: string;
  qty: number;
  type: string;
  size: string | null;
  areaSqFt: number | null;
  partNumber: string | null;
  description: string;
  material: string | null;
  color: string | null;
  notes: string | null;
}

export type PullSheetExtractionResult =
  | { status: "COMPLETE"; pageNumber: number; rows: ParsedPullSheetRow[] }
  | { status: "UNSUPPORTED"; reason: string };

type ShxAnnotation = { x: number; y: number; text: string };

// The exact header labels observed across all 13 real files. Matched
// case-insensitively/whitespace-trimmed since AutoCAD's own export adds a
// trailing space to several of these ("I.D. ", "Qty ").
const HEADER_LABELS: Record<string, RegExp> = {
  id: /^i\.?d\.?$/i,
  qty: /^qty$/i,
  type: /^type$/i,
  size: /^size$/i,
  areaSqFt: /^area\s*\(sq\.?\s*ft\.?\)$/i,
  partNumber: /^part number$/i,
  description: /^description$/i,
  material: /^material$/i,
  color: /^color$/i,
  notes: /^notes$/i,
};

// Real rows were observed ~8-13 units apart on the y axis (a single text
// row's own height); a gap past this starts a new row band. The header's
// own two-line label (I.D./Size/... and Qty/Type/... print as two separate
// SHX lines for the same logical header row, confirmed live) needs a wider
// band to be recognized as one header, not two rows.
const ROW_BAND_GAP = 6;
const HEADER_BAND_GAP = 14;
// A real page-decoration annotation (e.g. AutoCAD's rotated copyright
// notice running down the page edge) has a tall/rotated bounding box,
// unlike a real single-line table cell -- confirmed live, one real file's
// disclaimer text has rect height 715 vs ~11-13 for every genuine cell.
const MAX_ANNOTATION_HEIGHT = 30;

async function findPullSheetPage(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
): Promise<number | null> {
  const { text: pageTexts } = await extractText(pdf, { mergePages: false });
  for (let i = 0; i < pageTexts.length; i++) {
    if (/pull sheet/i.test(pageTexts[i])) return i + 1;
  }
  return null;
}

async function readShxAnnotations(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  pageNumber: number,
): Promise<ShxAnnotation[]> {
  const page = await pdf.getPage(pageNumber);
  const annotations = (await page.getAnnotations()) as Array<{
    titleObj?: { str?: string };
    contentsObj?: { str?: string };
    rect?: number[];
  }>;
  const out: ShxAnnotation[] = [];
  for (const a of annotations) {
    if (a.titleObj?.str !== "AutoCAD SHX Text") continue;
    const text = a.contentsObj?.str?.trim();
    if (!text || !a.rect) continue;
    if (a.rect[3] - a.rect[1] > MAX_ANNOTATION_HEIGHT) continue;
    out.push({ x: a.rect[0], y: a.rect[1], text });
  }
  return out;
}

type ColumnKey = keyof typeof HEADER_LABELS;

function detectHeaderColumns(annotations: ShxAnnotation[]): {
  anchors: Partial<Record<ColumnKey, number>>;
  headerYs: number[];
} {
  const anchors: Partial<Record<ColumnKey, number>> = {};
  const headerYs: number[] = [];
  for (const a of annotations) {
    for (const [key, pattern] of Object.entries(HEADER_LABELS) as [ColumnKey, RegExp][]) {
      if (pattern.test(a.text) && anchors[key] === undefined) {
        anchors[key] = a.x;
        headerYs.push(a.y);
      }
    }
  }
  return { anchors, headerYs };
}

function isHeaderBandY(y: number, headerYs: number[]): boolean {
  return headerYs.some((headerY) => Math.abs(headerY - y) <= HEADER_BAND_GAP);
}

function groupIntoRows(annotations: ShxAnnotation[]): ShxAnnotation[][] {
  const sorted = [...annotations].sort((a, b) => b.y - a.y);
  const rows: ShxAnnotation[][] = [];
  let currentRow: ShxAnnotation[] = [];
  let currentY: number | null = null;
  for (const a of sorted) {
    if (currentY === null || currentY - a.y > ROW_BAND_GAP) {
      if (currentRow.length > 0) rows.push(currentRow);
      currentRow = [];
    }
    currentRow.push(a);
    currentY = a.y;
  }
  if (currentRow.length > 0) rows.push(currentRow);
  return rows;
}

// A real column's data doesn't start at the same x as its own header
// label -- confirmed live, "Type"'s header sits at x=226 but that column's
// actual values start around x=189 (long values like "MIS BeMatrix
// Frames" run left of the label). Matching each cell to its single
// globally-nearest header anchor mis-files values like this into the
// WRONG (usually preceding) column. What does hold, and is exploited here
// instead: a row's real cells always appear in the same left-to-right
// column ORDER as the header (some columns just skipped, e.g. a hardware
// row has no Area value; a Wall Panel row has no Part Number) -- so
// walking a row's cells in x order against the header columns in x order,
// only ever advancing forward (never re-assigning an earlier column),
// correctly reconstructs which specific columns were skipped no matter
// how noisy any single column's absolute x position is.
function assignColumns(
  row: ShxAnnotation[],
  headerOrder: [ColumnKey, number][],
): Partial<Record<ColumnKey, string>> {
  const sorted = [...row].sort((a, b) => a.x - b.x);
  const result: Partial<Record<ColumnKey, string>> = {};
  let colIndex = 0;
  for (const cell of sorted) {
    while (colIndex < headerOrder.length - 1) {
      const currentDistance = Math.abs(cell.x - headerOrder[colIndex][1]);
      const nextDistance = Math.abs(cell.x - headerOrder[colIndex + 1][1]);
      if (nextDistance < currentDistance) colIndex++;
      else break;
    }
    if (colIndex >= headerOrder.length) break;
    result[headerOrder[colIndex][0]] = cell.text;
    colIndex++;
  }
  return result;
}

function numericOrNull(text: string | undefined): number | null {
  if (!text) return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// A real physical panel never exceeds a few hundred square feet -- one
// real file's own Area (SqFt) cell reads "6944430555.56", a genuine
// corrupted value baked into the source CAD block itself (that same
// file's Excel counterpart independently has rows sitting at #VALUE! from
// the same underlying formula corruption -- see
// design-cost-estimate-import-service.ts's own comment on Section 203).
// Not a parsing bug to fix here; just a value not worth trusting.
const MAX_PLAUSIBLE_AREA_SQFT = 10_000;

// Mirrors design-cost-estimate-import-service.ts's REAL_PART_NUMBER_PATTERN
// exactly -- same source template, same "Miscellaneous" rows carry a
// descriptive label ("Plexi track 3") in the Part Number column instead of
// a real SKU.
const REAL_PART_NUMBER_PATTERN = /\d{2,}.*\d{2,}/;

export async function extractPullSheetRows(bytes: Buffer): Promise<PullSheetExtractionResult> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const pageNumber = await findPullSheetPage(pdf);
  if (pageNumber === null) {
    return { status: "UNSUPPORTED", reason: "No page titled \"PULL SHEET\" found in this PDF." };
  }

  const annotations = await readShxAnnotations(pdf, pageNumber);
  const { anchors, headerYs } = detectHeaderColumns(annotations);
  if (Object.keys(anchors).length < 6) {
    return {
      status: "UNSUPPORTED",
      reason: `Pull Sheet table header not recognized (found ${Object.keys(anchors).length}/10 expected columns).`,
    };
  }

  const dataAnnotations = annotations.filter((a) => !isHeaderBandY(a.y, headerYs));
  const rowGroups = groupIntoRows(dataAnnotations);

  const headerOrder = (Object.entries(anchors) as [ColumnKey, number][]).sort((a, b) => a[1] - b[1]);

  const rows: ParsedPullSheetRow[] = [];
  for (const group of rowGroups) {
    const cells = assignColumns(group, headerOrder);
    if (!cells.id || cells.id.toUpperCase() === "SGBLANK") continue; // spacer/separator row
    const qty = numericOrNull(cells.qty);
    if (qty === null) continue;
    const areaSqFt = numericOrNull(cells.areaSqFt);
    rows.push({
      id: cells.id,
      qty,
      type: cells.type ?? "",
      size: cells.size ?? null,
      areaSqFt: areaSqFt !== null && areaSqFt <= MAX_PLAUSIBLE_AREA_SQFT ? areaSqFt : null,
      partNumber: cells.partNumber && REAL_PART_NUMBER_PATTERN.test(cells.partNumber) ? cells.partNumber : null,
      description: cells.description ?? "",
      material: cells.material ?? null,
      color: cells.color ?? null,
      notes: cells.notes ?? null,
    });
  }

  return { status: "COMPLETE", pageNumber, rows };
}
