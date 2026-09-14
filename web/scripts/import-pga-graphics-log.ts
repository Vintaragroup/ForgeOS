// One-time import of the Graphics team's real PGA-show tracking workbook
// (data/Graphics-operations/PGA SHOW GRAPHIC CONTROL LOG.xlsx) into
// ArtworkOrder, seeding the Graphics Production Hub with the show's actual
// current state instead of starting empty. See the Graphics Production Hub
// plan for the full field-mapping rationale.
//
// Reads two sheets:
//   - "Graphics Log 2026" (the master log, ~592 rows) -- one ArtworkOrder
//     per row, opportunityId set (find-or-create Company + a lightweight
//     Opportunity per client).
//   - "PGA Hub 2026" (~74 rows) -- shared/internal-program pieces with no
//     real exhibiting company. Modeled as showId-only ArtworkOrder rows
//     (opportunityId null -- see ArtworkOrder.showId's schema comment),
//     NOT as fake companies. The sheet's own "CLIENT" column here is
//     actually an internal program/area name ("Career Services", etc.),
//     not a real client -- there's no dedicated field for that, so it's
//     prefixed onto graphicCode instead of silently dropped.
//
// Deliberately NOT run through transitionArtworkOrder -- this is a bulk
// historical seed, not ~600 individual real actions, so each row is
// written directly at ITS OWN real current status (from the sheet's own
// STATUS column) with one synthetic ArtworkOrderEvent
// ("IMPORTED_FROM_LEGACY_LOG") so the audit trail still shows where it
// came from. This is a deliberate, one-time exception to
// artwork-order-service.ts's "transitionArtworkOrder is the sole writer"
// rule -- documented there too.
//
// A known, accepted fidelity gap: the sheet's ARTWORK STATUS column
// (Received / Reusing Existing / Needs Revision / Pending / Print Ready /
// Cancelled / N/A / Blank-No Graphic) tracks whether the CLIENT's source
// artwork has been received -- this doesn't cleanly map onto
// ArtworkOrderStatus (which tracks Expo's approval/production pipeline,
// not the client-artwork-received question) and no dedicated field for it
// exists in this schema slice. It's preserved as-is in the imported
// ArtworkOrderEvent's note, not silently dropped, but isn't queryable as
// its own field -- a real limitation to flag if "art received" reporting
// on imported rows turns out to matter.
//
// Safety: defaults to a dry run that only prints a plan. Pass --apply to
// actually write. Re-running with --apply is safe -- an ArtworkOrder
// already imported for the same (opportunity-or-show, graphicCode) pair is
// skipped, not duplicated.
//
// Usage:
//   npx tsx scripts/import-pga-graphics-log.ts              # dry run
//   npx tsx scripts/import-pga-graphics-log.ts --apply       # writes

import "dotenv/config";
import path from "node:path";
import ExcelJS from "exceljs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { cellText } from "../src/lib/xlsx-utils";
import type {
  ArtworkOrderStatus,
  ExistingGraphicsStatus,
  PostShowStatus,
  PostShowCondition,
} from "../src/generated/prisma/enums";

const APPLY = process.argv.includes("--apply");

const WORKBOOK_PATH = path.join(__dirname, "../../data/Graphics-operations/PGA SHOW GRAPHIC CONTROL LOG.xlsx");
const SHOW_NAME = "PGA Show";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const db = new PrismaClient({ adapter });

// -- Real vendor roster, from the workbook's own "Data Sheet" tab --------
// (Vendor Initials -> Vendor Full Name). Seeded find-or-create by
// initials, not blindly re-created if a Vendor with this initials value
// already exists.
const VENDOR_ROSTER: { initials: string; name: string }[] = [
  { initials: "A3", name: "A3Visuals (Miami)" },
  { initials: "BINCA", name: "Binca (Miami)" },
  { initials: "BINICK", name: "Binick (Miami)" },
  { initials: "FUSION", name: "Fusion (Orlando)" },
  { initials: "DTP", name: "Design to Print (NV)" },
  { initials: "EXPODEPOT", name: "ExpoDepot (NY)" },
  { initials: "ULTIMATE", name: "UltimateSigns (ORLANDO)" },
  { initials: "SUPERCOLOR", name: "SuperColor Digital (NV)" },
  { initials: "OLFP", name: "Orlando Large Format Printing" },
  { initials: "SPEEDPRO", name: "SpeedPro (ORLANDO)" },
  { initials: "OLYMPUS", name: "Olympus Custom Print (ORLANDO)" },
  { initials: "FGS", name: "Florida Graphic Services" },
  { initials: "RIOT", name: "Riot (ORLANDO)" },
  { initials: "THOMAS PRINT", name: "Thomas Print Works (ORLANDO)" },
  { initials: "EXPO - MIAMI", name: "Miami" },
];

const EXISTING_GRAPHICS_STATUS_MAP: Record<string, ExistingGraphicsStatus> = {
  "new image": "NEW_IMAGE",
  existing: "EXISTING",
  damaged: "DAMAGED",
  "not existing": "NOT_EXISTING",
};

// The sheet's finer physical-production STATUS column -> ArtworkOrderStatus.
// Every value actually observed in the live 2026 data is covered; the rest
// of Data Sheet's own 15-value catalog is mapped defensively in case
// PGA Hub 2026 or a future year's tab uses a value the master log didn't.
// Ambiguous cases are called out below rather than guessed silently.
const STATUS_MAP: Record<string, ArtworkOrderStatus> = {
  "not printed": "PRODUCTION_GO_AHEAD",
  "pending client approval": "PROOF_UNDER_REVIEW",
  packed: "PACKAGED_READY",
  "in production": "IN_PRODUCTION",
  // "Complete" is ambiguous between "production complete" and "shipped" --
  // treated as PACKAGED_READY (done and ready), not overclaiming delivery.
  complete: "PACKAGED_READY",
  reprint: "REPRINT_REQUESTED",
  "pending art": "ORDER_DRAFTED",
  "pending proof": "EXPO_PROOF_CHECK",
  "client approved": "PROOF_APPROVED",
  "pending graphic specs": "ORDER_DRAFTED",
  cancelled: "CANCELLED",
  "received from vendor": "RECEIVED_FROM_VENDOR",
  inspected: "INSPECTED",
  "client provided": "PACKAGED_READY",
};

const POST_SHOW_STATUS_MAP: Record<string, PostShowStatus> = {
  "not received": "NOT_RECEIVED",
  "expo storage": "EXPO_STORAGE",
  "ship to client": "SHIP_TO_CLIENT",
  discarded: "DISCARDED",
};

const POST_SHOW_CONDITION_MAP: Record<string, PostShowCondition> = {
  "ok to reuse": "OK_TO_REUSE",
  damaged: "DAMAGED",
  dirty: "DIRTY",
  product: "PRODUCT",
};

function num(v: string): number | null {
  const n = Number(v.replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) && v.trim() !== "" ? n : null;
}

function boolFromCell(v: string): boolean {
  return v.trim().toLowerCase() === "true";
}

interface ParsedRow {
  client: string;
  accountExecutive: string;
  boothNumber: string;
  graphicCode: string;
  vendorInitials: string;
  material: string;
  finishingDetails: string;
  widthIn: number | null;
  heightIn: number | null;
  qty: number;
  existingGraphicsStatus: ExistingGraphicsStatus | null;
  artDueDate: Date | null;
  artworkStatusRaw: string;
  status: ArtworkOrderStatus;
  verifiedSizes: boolean;
  postShowStatus: PostShowStatus | null;
  postShowCondition: PostShowCondition | null;
  comments: string;
}

// The two real sheets do NOT share one fixed column layout -- PGA Hub 2026
// inserts an extra "DATE COMPLETED" column before STATUS that Graphics Log
// 2026 doesn't have, and uses "AE"/"Proof Confirmed?"/" Graphics Status"
// (leading space) instead of "ACCOUNT EXECUTIVE"/"Proof Approved &
// Printed"/"Existing Graphics Status". A fixed positional read would
// silently misalign STATUS onward for one of the two sheets -- this reads
// each sheet's own header row and looks columns up by name instead.
function buildHeaderIndex(row: ExcelJS.Row): Map<string, number> {
  const map = new Map<string, number>();
  for (let c = 1; c <= 32; c++) {
    const text = cellText(row.getCell(c).value).trim().toLowerCase();
    if (text) map.set(text, c);
  }
  return map;
}

function requireCol(headerIndex: Map<string, number>, ...aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headerIndex.get(alias.toLowerCase());
    if (idx) return idx;
  }
  throw new Error(`Could not find a column matching any of: ${aliases.join(" / ")}`);
}

function optionalCol(headerIndex: Map<string, number>, ...aliases: string[]): number | null {
  for (const alias of aliases) {
    const idx = headerIndex.get(alias.toLowerCase());
    if (idx) return idx;
  }
  return null;
}

interface ColumnMap {
  client: number;
  accountExecutive: number | null;
  boothNumber: number;
  graphicCode: number;
  vendor: number;
  material: number;
  finishingDetails: number | null;
  width: number;
  height: number;
  qty: number;
  existingStatus: number | null;
  artDue: number | null;
  artworkStatus: number | null;
  status: number;
  verifiedSizes: number | null;
  postShowStatus: number | null;
  postShowCondition: number | null;
  comments: number | null;
}

function resolveColumns(headerIndex: Map<string, number>): ColumnMap {
  return {
    client: requireCol(headerIndex, "CLIENT"),
    accountExecutive: optionalCol(headerIndex, "ACCOUNT EXECUTIVE", "AE"),
    boothNumber: requireCol(headerIndex, "BOOTH #"),
    graphicCode: requireCol(headerIndex, "GRAPHIC NAME"),
    vendor: requireCol(headerIndex, "Vendor"),
    material: requireCol(headerIndex, "GRAPHIC TYPE"),
    finishingDetails: optionalCol(headerIndex, "Graphic Finishing Details"),
    width: requireCol(headerIndex, 'WIDTH"'),
    height: requireCol(headerIndex, 'HEIGHT"'),
    qty: requireCol(headerIndex, "QTY"),
    existingStatus: optionalCol(headerIndex, "Existing Graphics Status", "Graphics Status"),
    artDue: optionalCol(headerIndex, "ART DUE"),
    artworkStatus: optionalCol(headerIndex, "ARTWORK STATUS"),
    status: requireCol(headerIndex, "STATUS"),
    verifiedSizes: optionalCol(headerIndex, "Verified Sizes?"),
    postShowStatus: optionalCol(headerIndex, "Post Show Status"),
    postShowCondition: optionalCol(headerIndex, "Post Show Condition"),
    comments: optionalCol(headerIndex, "Comments"),
  };
}

function cellAt(cells: string[], col: number | null): string {
  return col ? (cells[col - 1] ?? "") : "";
}

function parseRow(cells: string[], cols: ColumnMap): ParsedRow {
  const width = cellAt(cells, cols.width);
  const height = cellAt(cells, cols.height);
  const qty = cellAt(cells, cols.qty);
  const artDue = cellAt(cells, cols.artDue);

  return {
    client: cellAt(cells, cols.client).trim(),
    accountExecutive: cellAt(cells, cols.accountExecutive).trim(),
    boothNumber: cellAt(cells, cols.boothNumber).trim(),
    graphicCode: cellAt(cells, cols.graphicCode).trim(),
    vendorInitials: cellAt(cells, cols.vendor).trim(),
    material: cellAt(cells, cols.material).trim(),
    finishingDetails: cellAt(cells, cols.finishingDetails).trim(),
    widthIn: num(width),
    heightIn: num(height),
    qty: num(qty) ?? 1,
    existingGraphicsStatus: EXISTING_GRAPHICS_STATUS_MAP[cellAt(cells, cols.existingStatus).trim().toLowerCase()] ?? null,
    artDueDate: artDue.trim() ? new Date(artDue.trim()) : null,
    artworkStatusRaw: cellAt(cells, cols.artworkStatus).trim(),
    status: STATUS_MAP[cellAt(cells, cols.status).trim().toLowerCase()] ?? "PACKAGED_READY",
    verifiedSizes: boolFromCell(cellAt(cells, cols.verifiedSizes)),
    postShowStatus: POST_SHOW_STATUS_MAP[cellAt(cells, cols.postShowStatus).trim().toLowerCase()] ?? null,
    postShowCondition: POST_SHOW_CONDITION_MAP[cellAt(cells, cols.postShowCondition).trim().toLowerCase()] ?? null,
    comments: cellAt(cells, cols.comments).trim(),
  };
}

// Reads via exceljs's STREAMING reader, not workbook.xlsx.readFile -- the
// real workbook's own Excel-formatting bloat (conditional formatting
// applied across ~1M rows on the sheets this import actually needs)
// produces a 700MB+ uncompressed sheet XML that blows past V8's max
// string length when read the normal (whole-file-in-memory) way. The
// streaming reader processes row-by-row instead, and this opens its own
// fresh stream per sheet (simpler and safer than threading shared state
// through one pass over every sheet in the file, at the cost of reading
// the ~82MB file from disk twice).
async function readSheetRows(
  filePath: string,
  sheetName: string,
  headerRow: number,
): Promise<{ cells: string[]; cols: ColumnMap }[]> {
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});
  const rows: { cells: string[]; cols: ColumnMap }[] = [];
  let cols: ColumnMap | null = null;
  let consecutiveEmpty = 0;

  for await (const worksheetReader of reader) {
    // exceljs's own type declarations omit `.name` on WorksheetReader even
    // though the runtime object always sets it (workbook-reader.js assigns
    // it from the matching sheet before yielding) -- a real gap in
    // @types/exceljs, not a typo here.
    const name = (worksheetReader as unknown as { name: string }).name;
    if (name !== sheetName) continue;
    for await (const row of worksheetReader) {
      if (row.number === headerRow) {
        cols = resolveColumns(buildHeaderIndex(row));
        continue;
      }
      if (row.number <= headerRow || !cols) continue;
      const cells: string[] = [];
      for (let c = 1; c <= 32; c++) cells.push(cellText(row.getCell(c).value));
      if (cells.every((c) => c === "")) {
        consecutiveEmpty++;
        if (consecutiveEmpty > 50) break;
        continue;
      }
      consecutiveEmpty = 0;
      rows.push({ cells, cols });
    }
    break; // found and fully read the target sheet -- no need to stream the rest of the file
  }

  if (!cols) throw new Error(`Sheet not found (or header row ${headerRow} never seen): ${sheetName}`);
  return rows;
}

interface Tally {
  imported: number;
  skippedExisting: number;
  skippedNoClient: number;
  companiesCreated: Set<string>;
  vendorsCreated: Set<string>;
  opportunitiesCreated: number;
  unmatchedAe: Set<string>;
}

function newTally(): Tally {
  return {
    imported: 0,
    skippedExisting: 0,
    skippedNoClient: 0,
    companiesCreated: new Set(),
    vendorsCreated: new Set(),
    opportunitiesCreated: 0,
    unmatchedAe: new Set(),
  };
}

async function resolveVendorId(initials: string, tally: Tally, vendorCache: Map<string, string>): Promise<string | null> {
  if (!initials) return null;
  const cached = vendorCache.get(initials);
  if (cached) return cached;
  const existing = await db.vendor.findFirst({ where: { initials, deletedAt: null } });
  if (existing) {
    vendorCache.set(initials, existing.id);
    return existing.id;
  }
  const roster = VENDOR_ROSTER.find((v) => v.initials === initials);
  const name = roster?.name ?? initials;
  if (!APPLY) {
    tally.vendorsCreated.add(initials);
    return `dry-run-vendor:${initials}`;
  }
  const created = await db.vendor.create({ data: { name, initials } });
  tally.vendorsCreated.add(initials);
  vendorCache.set(initials, created.id);
  return created.id;
}

async function resolveOpportunityId(
  clientName: string,
  salesRepId: string | null,
  tally: Tally,
  opportunityCache: Map<string, string>,
): Promise<string | null> {
  const key = clientName.toLowerCase();
  const cached = opportunityCache.get(key);
  if (cached) return cached;

  // Case/spacing-insensitive match -- the real sheet itself is inconsistent
  // ("2Hemispheres" vs "2HEMISPHERES" on adjacent rows), so an exact-string
  // match would silently split one client into two Companies. Only the
  // WRITE calls below are guarded by APPLY -- the reads run either way, so
  // a dry run's counts stay accurate instead of undercounting whenever a
  // brand-new company also implies a brand-new Opportunity.
  let company = await db.company.findFirst({
    where: { deletedAt: null, name: { equals: clientName, mode: "insensitive" } },
  });
  if (!company) {
    tally.companiesCreated.add(clientName);
    if (APPLY) company = await db.company.create({ data: { name: clientName } });
  }

  const opportunity = company
    ? await db.opportunity.findFirst({ where: { deletedAt: null, companyId: company.id, showName: SHOW_NAME } })
    : null;

  if (!opportunity) {
    tally.opportunitiesCreated++;
    if (!APPLY) {
      opportunityCache.set(key, `dry-run-opp:${clientName}`);
      return opportunityCache.get(key)!;
    }
    const created = await db.opportunity.create({
      data: { companyId: company!.id, showName: SHOW_NAME, stage: "WON", salesRepId },
    });
    opportunityCache.set(key, created.id);
    return created.id;
  }

  if (salesRepId && !opportunity.salesRepId && APPLY) {
    // Backfill only -- never overwrite a salesRepId someone already set
    // deliberately (same posture as scripts/backfill-user-department-codes.ts).
    await db.opportunity.update({ where: { id: opportunity.id }, data: { salesRepId } });
  }
  opportunityCache.set(key, opportunity.id);
  return opportunity.id;
}

async function resolveSalesRepId(aeName: string, tally: Tally, userCache: Map<string, string | null>): Promise<string | null> {
  if (!aeName) return null;
  const key = aeName.toLowerCase();
  if (userCache.has(key)) return userCache.get(key)!;
  const user = await db.user.findFirst({ where: { deletedAt: null, name: { equals: aeName, mode: "insensitive" } } });
  if (!user) {
    tally.unmatchedAe.add(aeName);
    userCache.set(key, null);
    return null;
  }
  userCache.set(key, user.id);
  return user.id;
}

async function importSheet(
  filePath: string,
  sheetName: string,
  headerRow: number,
  mode: "client" | "hub",
  showId: string | null,
  tally: Tally,
  caches: {
    vendor: Map<string, string>;
    opportunity: Map<string, string>;
    user: Map<string, string | null>;
  },
) {
  const rows = await readSheetRows(filePath, sheetName, headerRow);
  console.log(`\n${sheetName}: ${rows.length} data rows found.`);

  for (const { cells, cols } of rows) {
    const parsed = parseRow(cells, cols);
    if (!parsed.client) {
      tally.skippedNoClient++;
      continue;
    }

    let opportunityId: string | null = null;
    let graphicCode = parsed.graphicCode || null;
    if (mode === "client") {
      const salesRepId = await resolveSalesRepId(parsed.accountExecutive, tally, caches.user);
      opportunityId = await resolveOpportunityId(parsed.client, salesRepId, tally, caches.opportunity);
    } else {
      // PGA Hub 2026's own "CLIENT" column is an internal program/area
      // name, not a real exhibiting company -- see this script's header
      // comment. No opportunity; the label rides along on graphicCode
      // instead of being dropped.
      graphicCode = graphicCode ? `${parsed.client} / ${graphicCode}` : parsed.client;
    }

    const vendorId = await resolveVendorId(parsed.vendorInitials, tally, caches.vendor);

    if (opportunityId?.startsWith("dry-run-opp:") || vendorId?.startsWith("dry-run-vendor:")) {
      tally.imported++;
      continue;
    }

    const dedupeWhere = opportunityId ? { opportunityId, graphicCode } : { showId, graphicCode };
    const existing = await db.artworkOrder.findFirst({ where: { ...dedupeWhere, deletedAt: null } });
    if (existing) {
      tally.skippedExisting++;
      continue;
    }

    if (!APPLY) {
      tally.imported++;
      continue;
    }

    const jobCode = `EXPO-IMPORT-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    const order = await db.artworkOrder.create({
      data: {
        opportunityId,
        showId: opportunityId ? null : showId,
        status: parsed.status,
        material: parsed.material || null,
        qty: parsed.qty,
        graphicCode,
        finishingDetails: parsed.finishingDetails || null,
        customWidth: parsed.widthIn ?? undefined,
        customHeight: parsed.heightIn ?? undefined,
        existingGraphicsStatus: parsed.existingGraphicsStatus,
        artDueDate: parsed.artDueDate,
        verifiedSizes: parsed.verifiedSizes,
        vendorId: vendorId && !vendorId.startsWith("dry-run") ? vendorId : null,
        postShowStatus: parsed.postShowStatus,
        postShowCondition: parsed.postShowCondition,
        postShowRecordedAt: parsed.postShowStatus ? new Date() : null,
        jobCode,
      },
    });
    await db.artworkOrderEvent.create({
      data: {
        artworkOrderId: order.id,
        fromStatus: null,
        toStatus: parsed.status,
        action: "IMPORTED_FROM_LEGACY_LOG",
        note: parsed.comments || null,
        detail: {
          sourceSheet: sheetName,
          artworkStatusRaw: parsed.artworkStatusRaw,
          boothNumber: parsed.boothNumber,
        },
        actorType: "SYSTEM",
      },
    });
    tally.imported++;
  }
}

async function main() {
  console.log(APPLY ? "Running with --apply: this WILL write to the database." : "Dry run (pass --apply to write).");

  let show = await db.show.findFirst({ where: { deletedAt: null, name: SHOW_NAME } });
  if (!show && APPLY) {
    show = await db.show.create({ data: { name: SHOW_NAME, venue: "Orlando, FL" } });
  }
  const showId = show?.id ?? null;
  if (!showId && !APPLY) {
    console.log(`(Dry run: would create a Show named "${SHOW_NAME}" for PGA Hub items.)`);
  }

  const tally = newTally();
  const caches = { vendor: new Map<string, string>(), opportunity: new Map<string, string>(), user: new Map<string, string | null>() };

  await importSheet(WORKBOOK_PATH, "Graphics Log 2026", 5, "client", showId, tally, caches);
  await importSheet(WORKBOOK_PATH, "PGA Hub 2026", 3, "hub", showId, tally, caches);

  console.log("\n--- Summary ---");
  console.log(`Imported: ${tally.imported}`);
  console.log(`Skipped (already imported): ${tally.skippedExisting}`);
  console.log(`Skipped (no client name): ${tally.skippedNoClient}`);
  console.log(`Companies created: ${tally.companiesCreated.size}`);
  console.log(`Opportunities created: ${tally.opportunitiesCreated}`);
  console.log(`Vendors created: ${tally.vendorsCreated.size}${tally.vendorsCreated.size ? ` (${[...tally.vendorsCreated].join(", ")})` : ""}`);
  if (tally.unmatchedAe.size > 0) {
    console.log(
      `Account executives with no matching User by name (salesRepId left null): ${[...tally.unmatchedAe].join(", ")}`,
    );
  }
  if (!APPLY) {
    console.log("\nThis was a dry run -- nothing was written. Re-run with --apply to commit.");
  }

  await db.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
