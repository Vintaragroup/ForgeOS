// Idempotent (re-runnable) seed of real, publicly documented combined
// state+local sales tax rates for major US trade-show/convention markets.
// Every rate below was looked up against a live source at the effective
// date noted in its comment -- see TaxRate's schema comment for why this
// project won't guess at figures. Rates change over time (quarterly, in
// some states); verify/update via /catalog/tax-rates before relying on
// these for actual tax collection on a live proposal.
//
// Run with: npx tsx scripts/seed-tax-rates.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

interface SeedRate {
  state: string;
  city: string | null;
  label?: string;
  rate: number; // e.g. 0.065 for 6.5%
  effectiveDate: string; // ISO date
  source: string;
}

// All rates as of 2026-08-11 (today), verified via Avalara/state DOR
// lookups -- see each row's `source` comment. Combined = state + county +
// city + any special district, already rolled into one number (see
// TaxRate's schema comment for why this project doesn't store the
// components separately).
const SEED_RATES: SeedRate[] = [
  {
    state: "FL",
    city: "Orlando",
    rate: 0.065,
    effectiveDate: "2026-08-11",
    source: "Orange County FL: 6% state + 0.5% county (Avalara, salestaxhandbook.com)",
  },
  {
    state: "IL",
    city: "Chicago",
    rate: 0.1025,
    effectiveDate: "2026-08-11",
    source: "Cook County / City of Chicago combined (Tax Foundation, midyear 2026)",
  },
  {
    state: "NV",
    city: "Las Vegas",
    rate: 0.08375,
    effectiveDate: "2026-08-11",
    source: "Clark County: 4.6% state + 3.775% county, no separate city rate (Avalara)",
  },
  {
    state: "NY",
    city: "New York",
    label: "New York, NY",
    rate: 0.08875,
    effectiveDate: "2026-08-11",
    source: "4.0% state + 4.5% NYC local + 0.375% MCTD (Avalara, tax.ny.gov)",
  },
  {
    state: "CA",
    city: "Los Angeles",
    rate: 0.0975,
    effectiveDate: "2026-08-11",
    source: "City of Los Angeles combined incl. district taxes (Avalara)",
  },
  {
    state: "GA",
    city: "Atlanta",
    rate: 0.089,
    effectiveDate: "2026-08-11",
    source: "4.0% state + 3.0% Fulton Co. + 1.5% city + 0.4% T-SPLOST (Avalara, GA DOR rate chart)",
  },
  {
    state: "TX",
    city: "Dallas",
    rate: 0.0825,
    effectiveDate: "2026-08-11",
    source: "6.25% state + 1% city + 1% special (Avalara, salestaxhandbook.com)",
  },
  {
    state: "TN",
    city: "Nashville",
    rate: 0.0975,
    effectiveDate: "2026-08-11",
    source: "Davidson County combined (Tax Foundation, midyear 2026)",
  },
  {
    state: "CA",
    city: "Anaheim",
    rate: 0.0775,
    effectiveDate: "2026-08-11",
    source: "Orange County CA combined incl. special district (Avalara)",
  },
  {
    state: "CA",
    city: "San Francisco",
    rate: 0.08625,
    effectiveDate: "2026-08-11",
    source: "7.25% CA base + 1.375% district taxes; consolidated city-county (Avalara, Quaderno)",
  },
  {
    state: "IN",
    city: "Indianapolis",
    rate: 0.07,
    effectiveDate: "2026-08-11",
    source: "Flat Indiana state rate, no local add-on (Avalara)",
  },
  {
    state: "LA",
    city: "New Orleans",
    rate: 0.1,
    effectiveDate: "2026-08-11",
    source: "5.0% state + local; city rates range 9.75-10.25% by district, 10% used as typical (Avalara)",
  },
  {
    state: "DC",
    city: null,
    label: "Washington, DC",
    rate: 0.06,
    effectiveDate: "2026-08-11",
    source:
      "Current general rate through 2026-09-30 (D.C. Law 26-55 raises it to 7% on 2026-10-01 -- update this row after that date)",
  },
];

async function main() {
  const adapter = new PrismaPg(process.env.DATABASE_URL!);
  const db = new PrismaClient({ adapter });

  for (const seed of SEED_RATES) {
    const existing = await db.taxRate.findFirst({
      where: { state: seed.state, city: seed.city, deletedAt: null },
    });

    if (existing) {
      await db.taxRate.update({
        where: { id: existing.id },
        data: { label: seed.label ?? null, rate: seed.rate, effectiveDate: new Date(seed.effectiveDate) },
      });
      console.log(`Updated: ${seed.city ?? seed.state}, ${seed.state} — ${(seed.rate * 100).toFixed(2)}%`);
    } else {
      await db.taxRate.create({
        data: {
          state: seed.state,
          city: seed.city,
          label: seed.label ?? null,
          rate: seed.rate,
          effectiveDate: new Date(seed.effectiveDate),
        },
      });
      console.log(`Created: ${seed.city ?? seed.state}, ${seed.state} — ${(seed.rate * 100).toFixed(2)}%`);
    }
  }

  await db.$disconnect();
}

main();
