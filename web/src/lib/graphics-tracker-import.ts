// Reading a Microsoft Lists production-tracker export.
//
// Everything here is pure: a CSV string in, mapped rows and complaints
// out. The script that writes to the database is a thin wrapper, so the
// mapping can be tested against the real export without a database.
//
// The export's shape, from "Seatrade Cruise Global - 260407.csv":
//   row 0  a ListSchema=... blob, ~1,087 columns wide
//   row 1  the real header
//   row 2+ data
//
// Multi-select columns arrive as JSON arrays ("[\"Expo\",\"Binca - Miami\"]"),
// single-select as bare strings.

import { orderTypeFromTrackerCode } from "@/lib/artwork-order-type";
import { reprintReasonFromTracker } from "@/lib/artwork-reprint";
import { normalizeVendorName } from "@/lib/graphics-vendors";
import { parseBoothNumber } from "@/lib/show-section";
import type { ArtworkOrderType, ArtworkProductionStatus, ArtworkReprintReason } from "@/generated/prisma/enums";

// Her Print Status vocabulary, mapped onto ours. The two halves of a
// split piece are told apart by vocabulary alone -- an in-house half is
// never "O.S ..." -- which is what makes it possible to pair an unordered
// Shop array with an unordered Print Status array.
const PRINT_STATUS: Record<string, ArtworkProductionStatus> = {
  "not printed": "NOT_STARTED",
  printing: "PRINTING",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
  "o.s not sent": "OS_NOT_SENT",
  "o.s sent": "OS_SENT",
  "o.s quote approved": "OS_QUOTE_APPROVED",
  "o.s proof approved": "OS_PROOF_APPROVED",
  "o.s received": "OS_RECEIVED",
  "o.s received partially": "OS_RECEIVED_PARTIALLY",
  "o.s. delivered to showsite": "OS_DELIVERED_TO_SHOWSITE",
  "o.s delivered to showsite": "OS_DELIVERED_TO_SHOWSITE",
};

// Not a production status at all -- it says where the piece came from or
// went, and always appears alongside a real status. ForgeOS models that
// axis as PostShowStatus.EXPO_STORAGE and the rollover link.
const STORAGE_MARKER = "storage";

// The two Shop values that aren't companies.
const SHOP_EXPO = "expo";
const SHOP_AM_PM = new Set(["ae / pm", "am/pm", "am / pm", "ae/pm"]);

export interface TrackerRow {
  rowNumber: number;
  orderType: ArtworkOrderType | null;
  // The sequence her team writes at the front of Print Order ("1", "307C").
  sequence: string | null;
  // What is left of Print Order after the sequence. For an exhibitor row
  // this is the client's name; for show-management and site work it
  // describes the piece.
  title: string;
  clientName: string | null;
  boothRaw: string | null;
  boothNumber: number | null;
  sectionLabel: string | null;
  amPmEmail: string | null;
  inHandDate: Date | null;
  specialInstructions: string | null;
  sentToShowsite: boolean | null;
  reprintReason: ArtworkReprintReason | null;
  fromStorage: boolean;
  skidCode: string | null;
  packed: boolean;
  cancelled: boolean;
  // One entry per half, already paired with its own status.
  halves: TrackerHalf[];
  warnings: string[];
}

export interface TrackerHalf {
  kind: "EXPO_IN_HOUSE" | "VENDOR" | "AM_PM_COORDINATED";
  // Her spelling, for matching against the vendor table.
  shopName: string | null;
  normalizedShopName: string | null;
  productionStatus: ArtworkProductionStatus;
}

// The export opens with a ListSchema=... blob: one enormous quoted field
// holding the list's column definitions. Different CSV parsers disagree
// about where it ends -- papaparse folds the real header row into it --
// so the preamble is cut at the text level before parsing, by finding the
// line the header actually starts on.
//
// Anchored on "SM or EXH" because it is the first column of every export
// of this list and appears nowhere else in the schema blob.
// Anchored on "SM or EXH" AT THE START OF A LINE, followed by a comma.
// The bare string is not unique: the schema blob carries it as a column
// DisplayName about 27,000 characters earlier, and cutting there lands in
// the middle of the preamble and loses the header entirely. The header
// may or may not be quoted.
const HEADER_LINE = /(^|\r?\n)"?SM or EXH"?\s*,/;

export function stripListSchemaPreamble(raw: string): string {
  const text = raw.replace(/^\uFEFF/, "");
  const m = HEADER_LINE.exec(text);
  if (!m) return text;
  // m[1] is the line break itself, empty when the header is already first.
  return text.slice(m.index + m[1].length);
}

function cell(row: string[], index: number | undefined): string {
  if (index === undefined || index >= row.length) return "";
  return row[index].trim();
}

// A multi-select column, which is JSON when it has a value and bare text
// when the export wasn't sure.
function multi(raw: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map((v) => String(v).trim()).filter(Boolean);
  } catch {
    // Not JSON -- a single bare value.
  }
  return [raw];
}

// "1 - Boll Filter" -> { sequence: "1", title: "Boll Filter" }
// "307C- Sales Suite (Booth No. 1238)" -> { "307C", "Sales Suite (...)" }
// "SITE 3- Products B&B Vinyl" -> { "SITE 3", "Products B&B Vinyl" }
export function splitPrintOrder(raw: string): { sequence: string | null; title: string } {
  const value = raw.trim();
  const m = /^([A-Za-z0-9. ]{1,12}?)\s*-\s*(.+)$/.exec(value);
  if (!m) return { sequence: null, title: value };
  return { sequence: m[1].trim(), title: m[2].trim() };
}

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Pairs an unordered Shop array with an unordered Print Status array.
//
// This works because the two vocabularies are disjoint: anything starting
// "O.S" belongs to an outsourced half, everything else to an in-house or
// AM/PM one. The data bears it out -- of 60 two-shop rows in the Seatrade
// export, 58 carry exactly two statuses, always one of each kind.
function pairHalves(shops: string[], statuses: string[], warnings: string[]): { halves: TrackerHalf[]; fromStorage: boolean } {
  const fromStorage = statuses.some((s) => s.trim().toLowerCase() === STORAGE_MARKER);
  const mapped = statuses
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== STORAGE_MARKER)
    .map((s) => {
      const hit = PRINT_STATUS[s];
      if (!hit) warnings.push(`unknown print status ${JSON.stringify(s)}`);
      return hit ?? null;
    })
    .filter((s): s is ArtworkProductionStatus => s !== null);

  const outsourced = mapped.filter((s) => s.startsWith("OS_"));
  const inHouse = mapped.filter((s) => !s.startsWith("OS_"));

  const halves: TrackerHalf[] = [];
  for (const shop of shops) {
    const key = shop.trim().toLowerCase();
    if (key === SHOP_EXPO) {
      halves.push({ kind: "EXPO_IN_HOUSE", shopName: null, normalizedShopName: null, productionStatus: inHouse.shift() ?? "NOT_STARTED" });
    } else if (SHOP_AM_PM.has(key)) {
      halves.push({ kind: "AM_PM_COORDINATED", shopName: null, normalizedShopName: null, productionStatus: inHouse.shift() ?? "NOT_STARTED" });
    } else {
      halves.push({
        kind: "VENDOR",
        shopName: shop.trim(),
        normalizedShopName: normalizeVendorName(shop),
        productionStatus: outsourced.shift() ?? "OS_NOT_SENT",
      });
    }
  }

  // A status with no half to belong to means the row disagrees with
  // itself. Named rather than counted, because each kind means something
  // different and a human has to decide:
  //
  //   "Completed" with only an outsourced shop  -- in-house wording on a
  //       vendor half, or an Expo half nobody recorded
  //   "Completed" AND "Cancelled"               -- flatly contradictory
  //   two O.S statuses on one shop              -- the tracker kept the
  //       history in a multi-select; the more advanced one is taken
  //
  // Nothing is inferred from these. Guessing that "Completed" on a vendor
  // half means received would turn 4 ambiguous rows into 4 confident
  // wrong ones.
  const leftover = [...outsourced, ...inHouse];
  if (leftover.length > 0) {
    warnings.push(`no half to attach ${leftover.map((s) => JSON.stringify(s)).join(", ")} to`);
  }
  return { halves, fromStorage };
}

export function parseTrackerCsv(rows: string[][]): TrackerRow[] {
  // The caller strips the schema preamble, so row 0 is the header. Find
  // it rather than assume it, and refuse to carry on without it: mapping
  // every row to nulls and reporting "no unmapped values" is worse than
  // failing, because it looks like success.
  const headerRow = rows.findIndex((r) => r.some((c) => c.trim() === "SM or EXH"));
  if (headerRow === -1) {
    throw new Error(
      `Could not find the header row (no "SM or EXH" column). Was the ListSchema preamble stripped?`,
    );
  }
  const header = rows[headerRow].map((h) => h.trim());
  const at = (name: string) => {
    const i = header.indexOf(name);
    return i === -1 ? undefined : i;
  };
  for (const required of ["Print Order", "Shop", "Print Status"]) {
    if (at(required) === undefined) throw new Error(`Export is missing the ${JSON.stringify(required)} column.`);
  }
  const col = {
    type: at("SM or EXH"),
    printOrder: at("Print Order"),
    booth: at("Booth"),
    section: at("Section"),
    approval: at("Approval"),
    amPm: at("AM/PM"),
    shop: at("Shop"),
    printStatus: at("Print Status"),
    packed: at("Packed"),
    special: at("Special Instructions"),
    inHand: at("OS In-Hand Date"),
    sentToShowsite: at("Sent to Showsite"),
    reprint: at("Reprint Reason"),
  };

  const out: TrackerRow[] = [];
  for (let i = headerRow + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row.some((c) => c.trim())) continue;

    const warnings: string[] = [];
    const typeRaw = cell(row, col.type);
    const orderType = orderTypeFromTrackerCode(typeRaw);
    if (typeRaw && !orderType) warnings.push(`unknown SM or EXH value ${JSON.stringify(typeRaw)}`);

    const { sequence, title } = splitPrintOrder(cell(row, col.printOrder));
    const boothRaw = cell(row, col.booth) || null;
    const { halves, fromStorage } = pairHalves(
      multi(cell(row, col.shop)),
      multi(cell(row, col.printStatus)),
      warnings,
    );

    const packedValues = multi(cell(row, col.packed)).map((v) => v.trim());
    const approvals = multi(cell(row, col.approval)).map((v) => v.trim().toLowerCase());

    // Her Packed column holds a status AND a crate id in the same field.
    const skidCode = packedValues.find((v) => /^item\b/i.test(v)) ?? null;

    const reprintRaw = cell(row, col.reprint);
    const reprintReason = reprintRaw ? reprintReasonFromTracker(reprintRaw) : null;
    if (reprintRaw && !reprintReason) warnings.push(`unknown reprint reason ${JSON.stringify(reprintRaw)}`);

    const sentRaw = multi(cell(row, col.sentToShowsite)).map((v) => v.trim().toLowerCase());

    out.push({
      rowNumber: i + 1,
      orderType,
      sequence,
      title,
      // Only an exhibitor row names a client; the rest describe a piece.
      clientName: orderType === "EXHIBITOR" ? title : null,
      boothRaw,
      boothNumber: parseBoothNumber(boothRaw),
      sectionLabel: cell(row, col.section) || null,
      amPmEmail: cell(row, col.amPm).toLowerCase() || null,
      inHandDate: parseDate(cell(row, col.inHand)),
      specialInstructions: cell(row, col.special) || null,
      sentToShowsite: sentRaw.length === 0 ? null : sentRaw.includes("yes"),
      reprintReason,
      fromStorage,
      skidCode,
      packed: packedValues.some((v) => v.toLowerCase() === "completed"),
      // Cancellation is stated in the Approval column; the Print Status
      // and Packed columns echo it but are not the source.
      cancelled: approvals.includes("cancelled"),
      halves,
      warnings,
    });
  }
  return out;
}

export interface TrackerSummary {
  rows: number;
  byType: Record<string, number>;
  halves: number;
  distinctShops: string[];
  distinctAmPm: string[];
  withInHandDate: number;
  withSkid: number;
  fromStorage: number;
  clientNames: string[];
  warnings: { rowNumber: number; message: string }[];
}

export function summarize(rows: TrackerRow[]): TrackerSummary {
  const byType: Record<string, number> = {};
  const shops = new Set<string>();
  const amPm = new Set<string>();
  const clients = new Set<string>();
  const warnings: { rowNumber: number; message: string }[] = [];
  let halves = 0;
  let withInHandDate = 0;
  let withSkid = 0;
  let fromStorage = 0;

  for (const r of rows) {
    byType[r.orderType ?? "(unknown)"] = (byType[r.orderType ?? "(unknown)"] ?? 0) + 1;
    halves += r.halves.length;
    for (const h of r.halves) if (h.shopName) shops.add(h.shopName);
    if (r.amPmEmail) amPm.add(r.amPmEmail);
    if (r.clientName) clients.add(r.clientName);
    if (r.inHandDate) withInHandDate += 1;
    if (r.skidCode) withSkid += 1;
    if (r.fromStorage) fromStorage += 1;
    for (const w of r.warnings) warnings.push({ rowNumber: r.rowNumber, message: w });
  }

  return {
    rows: rows.length,
    byType,
    halves,
    distinctShops: [...shops].sort(),
    distinctAmPm: [...amPm].sort(),
    withInHandDate,
    withSkid,
    fromStorage,
    clientNames: [...clients].sort(),
    warnings,
  };
}
