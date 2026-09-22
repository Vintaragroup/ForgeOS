// Imports a Microsoft Lists production-tracker export as one show's
// graphics history.
//
// Pieces are attached to the SHOW, not to client opportunities. For an
// archived show that is the honest shape: the export names 86 exhibitors
// but carries no contact, no deal and no company record, so inventing 86
// companies and opportunities would put CRM rows into production that
// nobody asked for and no one would maintain. The client's name is kept
// on the piece instead.
//
// Everything imported is archived on arrival -- see ArtworkOrder
// .archivedAt. The show already happened; none of this is work to do.
//
// Usage:
//   npx tsx scripts/import-graphics-tracker.ts --file "<export.csv>" \
//     --show "Seatrade Cruise Global 2026"
//   ... --start 2026-04-27 --end 2026-04-29 --apply
//
// Dry run by default. --start/--end set the show's dates and are required
// to create a new show: an undated show is what made the PGA import look
// like live work in the first place.

import "dotenv/config";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { parseTrackerCsv, stripListSchemaPreamble, summarize, type TrackerRow } from "../src/lib/graphics-tracker-import";
import { normalizeVendorName } from "../src/lib/graphics-vendors";
import type { ArtworkOrderStatus } from "../src/generated/prisma/enums";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function parseDate(v: string | undefined, label: string): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`--${label} is not a date I understand: ${v}`);
  return d;
}

// The order's own status, derived from what the tracker says happened.
// The halves carry the real production detail; this is the one-line
// summary the pipeline still reads.
function statusFor(row: TrackerRow): ArtworkOrderStatus {
  if (row.cancelled) return "CANCELLED";
  if (row.sentToShowsite) return "DELIVERED_AT_SHOW";
  if (row.packed) return "PACKAGED_READY";
  const settled = row.halves.length > 0 && row.halves.every((h) => ["COMPLETED", "OS_RECEIVED", "OS_DELIVERED_TO_SHOWSITE", "CANCELLED"].includes(h.productionStatus));
  return settled ? "PACKAGED_READY" : "IN_PRODUCTION";
}

// "Section 4 (1800-2299)" -> the name and the range, so the show's floor
// sections can be created from the data rather than typed again.
function parseSectionLabel(label: string): { name: string; boothStart: number; boothEnd: number } | null {
  const m = /^(.+?)\s*\((\d+)\s*-\s*(\d+)\)\s*$/.exec(label.trim());
  if (!m) return null;
  return { name: m[1].trim(), boothStart: Number(m[2]), boothEnd: Number(m[3]) };
}

async function main() {
  const file = flag("file");
  const showName = flag("show");
  if (!file || !showName) {
    console.error('Usage: npx tsx scripts/import-graphics-tracker.ts --file "<export.csv>" --show "<show name>" [--start YYYY-MM-DD --end YYYY-MM-DD] [--apply]');
    process.exit(1);
  }
  const start = parseDate(flag("start"), "start");
  const end = parseDate(flag("end"), "end");

  const raw = stripListSchemaPreamble(readFileSync(file, "utf8"));
  const rows = parseTrackerCsv(Papa.parse<string[]>(raw, { header: false, skipEmptyLines: false }).data);
  const s = summarize(rows);

  const db = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
  const host = (() => {
    try {
      return new URL(process.env.DATABASE_URL!).host;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`database: ${host}`);
  console.log(APPLY ? "mode: APPLY (writes)\n" : "mode: dry run -- nothing will be written\n");

  // --- vendors ---------------------------------------------------------
  const vendors = await db.vendor.findMany({ where: { deletedAt: null }, select: { id: true, name: true } });
  const vendorByNormalized = new Map(vendors.map((v) => [normalizeVendorName(v.name), v]));
  const unmatchedShops = s.distinctShops.filter((shop) => !vendorByNormalized.has(normalizeVendorName(shop)));

  // --- show ------------------------------------------------------------
  const existingShow = await db.show.findFirst({ where: { name: showName, deletedAt: null }, select: { id: true, eventStartDate: true } });
  if (!existingShow && !start) {
    throw new Error(
      `"${showName}" doesn't exist yet, so --start (and --end) are required. An undated show is exactly what made the PGA import read as live work.`,
    );
  }

  // --- floor sections --------------------------------------------------
  const sectionLabels = [...new Set(rows.map((r) => r.sectionLabel).filter((l): l is string => Boolean(l)))].sort();
  const sections = sectionLabels.map(parseSectionLabel).filter((x): x is NonNullable<typeof x> => x !== null);

  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[statusFor(r)] = (statusCounts[statusFor(r)] ?? 0) + 1;

  console.log(`show: ${showName}${existingShow ? " (exists)" : " (will be created)"}`);
  if (start || end) console.log(`  dates: ${start?.toISOString().slice(0, 10) ?? "?"} .. ${end?.toISOString().slice(0, 10) ?? "?"}`);
  console.log(`\npieces to import: ${rows.length}`);
  for (const [type, n] of Object.entries(s.byType).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${type}`);
  console.log("\nstatus they will land in (all archived):");
  for (const [st, n] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${st}`);
  console.log(`\nproduction halves: ${s.halves}`);
  console.log(`floor sections: ${sections.length} (${sections.map((x) => x.name).join(", ") || "none"})`);
  console.log(`in-hand dates: ${s.withInHandDate}/${rows.length}`);
  console.log(`from storage: ${s.fromStorage}`);

  if (unmatchedShops.length > 0) {
    console.log(`\nshops with no vendor row -- run reconcile-graphics-vendors first:`);
    for (const shop of unmatchedShops) console.log(`  ${shop}`);
    throw new Error("Refusing to import with unmatched shops: the halves would lose their vendor.");
  }
  console.log("\nall shops matched to vendors.");

  // "Expo" in the tracker means in-house production, but not which sign
  // shop. Rather than writing a routing the service itself would reject
  // (EXPO_IN_HOUSE requires an office that HAS a sign shop), resolve it:
  // if exactly one office can produce in-house, that is the one the
  // tracker means. This is Miami's tracker, and Miami is currently the
  // only such office. If that ever stops being true, this stops guessing.
  const signShops = await db.office.findMany({ where: { deletedAt: null, hasSignShop: true }, select: { code: true, name: true } });
  const inHouseHalves = rows.reduce((n, r) => n + r.halves.filter((h) => h.kind === "EXPO_IN_HOUSE").length, 0);
  if (inHouseHalves > 0 && signShops.length !== 1) {
    throw new Error(
      signShops.length === 0
        ? `${inHouseHalves} pieces were produced in-house, but no office has a sign shop on record.`
        : `${inHouseHalves} pieces were produced in-house and ${signShops.length} offices have sign shops (${signShops
            .map((o) => o.code)
            .join(", ")}) -- pass the right one rather than letting this guess.`,
    );
  }
  const inHouseOffice = signShops[0]?.code ?? null;
  if (inHouseHalves > 0) console.log(`in-house halves: ${inHouseHalves}, attributed to ${signShops[0].name}.`);

  // The tracker has no material column, so nothing here can feed the
  // material-based turnaround table. Worth saying out loud rather than
  // letting every imported piece silently classify as rigid.
  console.log("\nNOTE: this export carries no material column, so imported pieces have no material.");
  console.log("      graphics-sla.ts classifies a material-less piece as RIGID, so its turnaround");
  console.log("      figure is a default, not a fact. The PGA control log did carry material.");

  if (s.warnings.length > 0) {
    console.log(`\n${s.warnings.length} row(s) the export contradicts itself on -- imported with what is unambiguous:`);
    for (const w of s.warnings) console.log(`  row ${w.rowNumber}: ${w.message}`);
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to write.");
    await db.$disconnect();
    return;
  }

  const show =
    existingShow ??
    (await db.show.create({ data: { name: showName, eventStartDate: start ?? null, eventEndDate: end ?? null } }));
  if (existingShow && (start || end)) {
    await db.show.update({ where: { id: show.id }, data: { ...(start ? { eventStartDate: start } : {}), ...(end ? { eventEndDate: end } : {}) } });
  }

  for (const section of sections) {
    const clash = await db.showSection.findFirst({ where: { showId: show.id, name: section.name, deletedAt: null } });
    if (!clash) await db.showSection.create({ data: { showId: show.id, ...section } });
  }

  const archivedAt = new Date();
  let created = 0;
  for (const row of rows) {
    const order = await db.artworkOrder.create({
      data: {
        showId: show.id,
        jobCode: `EXPO-IMPORT-${show.id.slice(-6)}-${String(row.rowNumber).padStart(4, "0")}`,
        status: statusFor(row),
        orderType: row.orderType,
        // The client's name lives here because no company record is made.
        graphicCode: [row.sequence, row.title].filter(Boolean).join(" - ") || null,
        finishingDetails: row.specialInstructions,
        inHandDate: row.inHandDate,
        reprintReason: row.reprintReason,
        archivedAt,
        // Storage is provenance, and this is the field that already means
        // "this piece went into Expo storage".
        ...(row.fromStorage ? { postShowStatus: "EXPO_STORAGE" as const, postShowRecordedAt: archivedAt } : {}),
      },
      select: { id: true },
    });

    // vendorId is set from the first outside shop below, for the same
    // reason setArtworkRouting does it: it still drives the vendor portal
    // invite and the detail page's picker, and the two must not drift.
    // The first version of this wrote routings directly and left
    // vendorId null on 108 pieces.
    let firstVendorId: string | null = null;
    for (const half of row.halves) {
      const vendor = half.normalizedShopName ? vendorByNormalized.get(half.normalizedShopName) : undefined;
      if (half.kind === "VENDOR" && vendor && !firstVendorId) firstVendorId = vendor.id;
      await db.artworkOrderRouting.create({
        data: {
          artworkOrderId: order.id,
          kind: half.kind,
          vendorId: half.kind === "VENDOR" ? (vendor?.id ?? null) : null,
          officeCode: half.kind === "EXPO_IN_HOUSE" ? inHouseOffice : null,
          productionStatus: half.productionStatus,
        },
      });
    }
    if (firstVendorId) {
      await db.artworkOrder.update({ where: { id: order.id }, data: { vendorId: firstVendorId } });
    }
    created += 1;
  }

  console.log(`\napplied. ${created} piece(s) imported, all archived.`);
  const check = await db.artworkOrder.count({ where: { showId: show.id, deletedAt: null, archivedAt: null } });
  console.log(`unarchived pieces on this show (should be 0): ${check}`);
  await db.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
