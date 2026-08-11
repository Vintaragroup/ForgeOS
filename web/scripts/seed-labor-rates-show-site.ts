// Idempotent (re-runnable) backfill of overtime/double-time rates for the
// 78 show/site labor markets, plus a Supervision shop-labor department --
// both sourced directly from data/Catalog_Data/Materials_pulled_from_
// groundtruth/, real figures extracted from the historical workbooks, not
// guesses. See prisma/schema.prisma's LaborRateTier comment for why OT/DT
// are stored as their own real rates rather than a multiplier off
// straight time -- the source data itself doesn't follow one (Chicago's
// OT is 1.34x its ST, Huntsville's is 1.57x).
//
// The existing 78 CITY_MARKET rows (seeded earlier, before laborTier
// existed) hold only the straight-time figure -- this script tags each
// with laborTier=STRAIGHT_TIME and adds its missing OVERTIME row (all 78
// markets) and DOUBLE_TIME row (only the 15 markets that have one).
// unionStatus is deliberately left null/unspecified: the source data
// doesn't distinguish union from non-union labor for these markets.
//
// Run with: npx tsx scripts/seed-labor-rates-show-site.ts

import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const CSV_PATH = path.resolve(
  import.meta.dirname,
  "../../data/Catalog_Data/Materials_pulled_from_groundtruth/labor_rates_show_site.csv",
);

interface ShowSiteRow {
  city_market: string;
  st_rate: string;
  ot_rate: string;
  dt_rate: string;
  travel_required: string;
}

// Minimal quoted-field-aware CSV line parser -- sufficient for this file
// (no escaped quotes within quoted fields appear in the source), not a
// general-purpose CSV library since none is a project dependency.
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function parseCsv(raw: string): ShowSiteRow[] {
  const lines = raw.replace(/^﻿/, "").split("\n").filter((l) => l.trim() !== "");
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, i) => (row[key] = (values[i] ?? "").trim()));
    return row as unknown as ShowSiteRow;
  });
}

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  const rows = parseCsv(readFileSync(CSV_PATH, "utf-8"));
  let stTagged = 0;
  let otCreated = 0;
  let otUpdated = 0;
  let dtCreated = 0;
  let dtUpdated = 0;
  let stNotFound = 0;

  for (const row of rows) {
    const city = row.city_market;
    const notes = row.travel_required || null;

    const stRow = await db.laborRate.findFirst({
      where: { rateType: "CITY_MARKET", city, laborTier: null, deletedAt: null },
    });
    if (stRow) {
      await db.laborRate.update({
        where: { id: stRow.id },
        data: { laborTier: "STRAIGHT_TIME", notes, rate: Number(row.st_rate) },
      });
      stTagged++;
    } else {
      stNotFound++;
      console.warn(`No existing straight-time row found for "${city}" -- skipping (verify city name match)`);
      continue;
    }

    const existingOt = await db.laborRate.findFirst({
      where: { rateType: "CITY_MARKET", city, laborTier: "OVERTIME", deletedAt: null },
    });
    if (existingOt) {
      await db.laborRate.update({ where: { id: existingOt.id }, data: { rate: Number(row.ot_rate), notes } });
      otUpdated++;
    } else {
      await db.laborRate.create({
        data: { rateType: "CITY_MARKET", city, laborTier: "OVERTIME", rate: Number(row.ot_rate), notes },
      });
      otCreated++;
    }

    if (row.dt_rate) {
      const existingDt = await db.laborRate.findFirst({
        where: { rateType: "CITY_MARKET", city, laborTier: "DOUBLE_TIME", deletedAt: null },
      });
      if (existingDt) {
        await db.laborRate.update({ where: { id: existingDt.id }, data: { rate: Number(row.dt_rate), notes } });
        dtUpdated++;
      } else {
        await db.laborRate.create({
          data: { rateType: "CITY_MARKET", city, laborTier: "DOUBLE_TIME", rate: Number(row.dt_rate), notes },
        });
        dtCreated++;
      }
    }
  }

  // Supervision -- $25/hr appears identically on both the Base sheet
  // (historical_rate_2018) and the Show Services sheet, independently
  // sourced, unlike a one-off "Carpenters" figure this data doesn't have.
  const existingSupervision = await db.laborRate.findFirst({
    where: { rateType: "DEPARTMENT", departmentCode: "SV", deletedAt: null },
  });
  if (existingSupervision) {
    await db.laborRate.update({ where: { id: existingSupervision.id }, data: { rate: 25 } });
    console.log("Updated: Supervision (SV) — $25.00/hr");
  } else {
    await db.laborRate.create({
      data: { rateType: "DEPARTMENT", departmentCode: "SV", departmentName: "Supervision", rate: 25 },
    });
    console.log("Created: Supervision (SV) — $25.00/hr");
  }

  console.log({ marketsProcessed: rows.length, stTagged, stNotFound, otCreated, otUpdated, dtCreated, dtUpdated });

  await db.$disconnect();
}

main();
