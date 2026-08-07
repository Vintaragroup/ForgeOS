// Seeds real rate/price data extracted during the Phase 0/1 audit --
// not placeholders. See docs/business-rules.md Rules 1 and 9 for the
// exact cell references each value came from.
//
// Run with: npx tsx prisma/seed.ts

import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { LaborRateType } from "../src/generated/prisma/enums";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const db = new PrismaClient({ adapter });

// business-rules.md Rule 1: 15 department rates, hardcoded on COMPONENT 1
// only in the source workbook and fanned out by formula to 43 sibling
// sheets. Single-sourced here instead.
const DEPARTMENT_RATES: { code: string; name: string; rate: number }[] = [
  { code: "DE", name: "Design", rate: 66.15 },
  { code: "EN", name: "Engineering & Purchasing", rate: 58.8 },
  { code: "PM", name: "Project Management", rate: 58.8 },
  { code: "HA", name: "Handling", rate: 38.71 },
  { code: "GR", name: "Graphics", rate: 61.25 },
  { code: "CC", name: "CNC", rate: 38.71 },
  { code: "EF", name: "Exhibit Fabrication", rate: 38.71 },
  { code: "ME", name: "Metal", rate: 38.71 },
  { code: "ES", name: "Estimating", rate: 58.8 },
  { code: "LP", name: "Laminating/Painting", rate: 38.71 },
  { code: "EL", name: "Electrical", rate: 38.71 },
  { code: "CR", name: "Crates", rate: 38.71 },
  { code: "AS", name: "Assembly", rate: 38.71 },
  { code: "SR", name: "Shipping", rate: 38.71 },
  { code: "WH", name: "Warehouse", rate: 38.71 },
  { code: "AM", name: "AM", rate: 58.8 }, // workbook label truncated; preserved as-is
];

// business-rules.md Rule 9: Standard Cost Sheet's flat rental prices.
// WAREHOUSE LABOR's derivation ($35 x 2 x 1.25 = $87.50) is preserved in
// priceDerivationNote rather than lost the way it nearly was in the
// original single-formula-cell workbook.
const RENTAL_ITEMS: { name: string; unitPrice: number; note?: string }[] = [
  { name: "Flooring — per square foot", unitPrice: 4.9 },
  { name: "Hanging Sign (existing) — hardware only, existing graphic", unitPrice: 1000 },
  { name: "Frames", unitPrice: 100 },
  { name: "Slatwalls", unitPrice: 250 },
  { name: "Doors", unitPrice: 150 },
  { name: "Stem Lights", unitPrice: 50 },
  { name: "Shelves", unitPrice: 100 },
  { name: "Pedestals", unitPrice: 250 },
  {
    name: "Warehouse Labor (pull & prep) / hr",
    unitPrice: 87.5,
    note: "Derived in the original workbook as =(35*2)*1.25 — base rate $35, doubled, plus 25% markup.",
  },
];

async function main() {
  for (const d of DEPARTMENT_RATES) {
    await db.laborRate.upsert({
      where: { id: `dept-${d.code}` },
      create: {
        id: `dept-${d.code}`,
        rateType: LaborRateType.DEPARTMENT,
        departmentCode: d.code,
        departmentName: d.name,
        rate: d.rate,
      },
      update: { rate: d.rate, departmentName: d.name },
    });
  }
  console.log(`Seeded ${DEPARTMENT_RATES.length} department labor rates.`);

  for (const r of RENTAL_ITEMS) {
    const existing = await db.rentalItem.findFirst({ where: { name: r.name } });
    if (existing) {
      await db.rentalItem.update({
        where: { id: existing.id },
        data: { unitPrice: r.unitPrice, priceDerivationNote: r.note },
      });
    } else {
      await db.rentalItem.create({
        data: { name: r.name, unitPrice: r.unitPrice, priceDerivationNote: r.note },
      });
    }
  }
  console.log(`Seeded ${RENTAL_ITEMS.length} rental items.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
