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

// Materials catalog: a real gap the workbook never filled (see
// business-rules.md Rule 2 -- material lines were always open, per-job,
// per-component free entry, never a shared price list). Built two ways:
//
// 1. REAL, evidenced entries -- extracted directly from the raw
//    MATERIAL/QTY/UNIT COST columns (Rule 2) across all 8 real historical
//    job workbooks in data/historical_jobs/xlsx/ (gitignored, local only).
//    "BeMatrix" -- the modular aluminum exhibit-frame system referenced
//    in several real jobs ("CUSTOM HALFWALL - BEMATRIX W/ SEG FABRIC",
//    "Custom corner bematrix connections") -- turned out to be the actual
//    real-world referent behind an internal shorthand for this research
//    pass. SEG (silicone-edge-graphic) fabric is BeMatrix's standard
//    panel infill product, and its $5.75/sq ft price is the
//    single-best-evidenced number in this whole catalog: identical across
//    18 line items spanning 7 different real jobs.
// 2. Industry-reference entries -- standard exhibit-shop materials with no
//    real-job evidence (the workbook never itemized raw wood/metal/acrylic
//    stock the way it did print substrates). Starting estimates only --
//    sourceNote says so on every one -- confirm against real supplier
//    pricing before using in a client-facing estimate.
const MATERIALS: {
  category: string;
  name: string;
  unit: string;
  currentUnitCost: number;
  sourceNote: string;
}[] = [
  // ---------- Wood & sheet goods (industry reference) ----------
  { category: "Wood & Sheet Goods", name: "3/4\" MDF Sheet", unit: "4x8 sheet", currentUnitCost: 55.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Wood & Sheet Goods", name: "1/2\" MDF Sheet", unit: "4x8 sheet", currentUnitCost: 40.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Wood & Sheet Goods", name: "3/4\" Birch Plywood, Cabinet Grade", unit: "4x8 sheet", currentUnitCost: 85.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Wood & Sheet Goods", name: "1/2\" Baltic Birch Plywood", unit: "4x8 sheet", currentUnitCost: 75.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Wood & Sheet Goods", name: "1/4\" Luan Underlayment", unit: "4x8 sheet", currentUnitCost: 28.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Wood & Sheet Goods", name: "1x4 Poplar", unit: "linear ft", currentUnitCost: 3.5, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Wood & Sheet Goods", name: "2x4 Construction Lumber", unit: "linear ft", currentUnitCost: 1.2, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },

  // ---------- Metal & extrusion (industry reference) ----------
  { category: "Metal & Extrusion", name: "1.5\" Aluminum Extrusion, Exhibit Frame Grade", unit: "linear ft", currentUnitCost: 4.5, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Metal & Extrusion", name: "Aluminum Composite Panel (Dibond) 3mm", unit: "4x8 sheet", currentUnitCost: 140.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Metal & Extrusion", name: "Aluminum Sheet .063\"", unit: "4x8 sheet", currentUnitCost: 180.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Metal & Extrusion", name: "Aluminum Angle 1\"x1\"", unit: "linear ft", currentUnitCost: 2.25, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Metal & Extrusion", name: "Steel Square Tube 1\"x1\"", unit: "linear ft", currentUnitCost: 3.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Metal & Extrusion", name: "Perforated Metal Panel", unit: "4x8 sheet", currentUnitCost: 165.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },

  // ---------- Acrylic (2 real, 3 reference) ----------
  { category: "Acrylic", name: "Cast Acrylic 3mm Clear", unit: "4x8 sheet", currentUnitCost: 61.0, sourceNote: "Real: observed in 2 real jobs (Booksy, Poly Coat USA) at this exact price." },
  { category: "Acrylic", name: "Cast Acrylic 6mm Clear", unit: "4x8 sheet", currentUnitCost: 115.7, sourceNote: "Real: observed in 1 real job (Booksy)." },
  { category: "Acrylic", name: "Cast Acrylic 1/4\" Clear", unit: "4x8 sheet", currentUnitCost: 180.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Acrylic", name: "Frosted Acrylic 3mm", unit: "4x8 sheet", currentUnitCost: 70.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Acrylic", name: "Colored Acrylic 3mm", unit: "4x8 sheet", currentUnitCost: 78.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },

  // ---------- Printing substrates (3 real, 4 reference) ----------
  { category: "Printing Substrates", name: "SEG Fabric Graphic (single-side)", unit: "sq ft", currentUnitCost: 5.75, sourceNote: "Real: identical price across 18 line items spanning 7 different real jobs -- the best-evidenced number in this catalog. BeMatrix's standard silicone-edge-graphic panel infill." },
  { category: "Printing Substrates", name: "PVC Board 1/8\" White, Direct UV Print", unit: "sq ft", currentUnitCost: 6.4, sourceNote: "Real: observed 9 times across 4 real jobs at this exact price." },
  { category: "Printing Substrates", name: "Vinyl, Interior Grade Laminate", unit: "sq ft", currentUnitCost: 5.91, sourceNote: "Real: observed 3 times across 2 real jobs at this exact price." },
  { category: "Printing Substrates", name: "Coroplast 4mm", unit: "sq ft", currentUnitCost: 1.1, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Printing Substrates", name: "Foam Board 1/2\"", unit: "sq ft", currentUnitCost: 0.85, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Printing Substrates", name: "Backlit Film / Duratrans", unit: "sq ft", currentUnitCost: 8.5, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Printing Substrates", name: "Dye-Sublimation Tension Fabric", unit: "sq ft", currentUnitCost: 7.25, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },

  // ---------- BeMatrix system (2 real, 1 reference) ----------
  { category: "BeMatrix System", name: "BeMatrix Corner / Connection Hardware", unit: "connection", currentUnitCost: 290.0, sourceNote: "Real: observed in 1 real job (Booksy) -- \"Custom corner bematrix connections.\"" },
  { category: "BeMatrix System", name: "BeMatrix Halfwall Assembly w/ SEG Fabric", unit: "unit", currentUnitCost: 1500.0, sourceNote: "Real: observed in 1 real job (Barclay Group) -- \"CUSTOM HALFWALL - BEMATRIX W/ SEG FABRIC.\"" },
  { category: "BeMatrix System", name: "BeMatrix Standard Aluminum Frame, 8ft", unit: "frame", currentUnitCost: 185.0, sourceNote: "Industry-reference starting estimate -- confirm against your current BeMatrix reseller pricing." },

  // ---------- Hardware & fasteners (industry reference) ----------
  { category: "Hardware & Fasteners", name: "Cam Locks / Knock-Down Fittings", unit: "set", currentUnitCost: 4.5, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Hardware & Fasteners", name: "Piano Hinge", unit: "linear ft", currentUnitCost: 6.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Hardware & Fasteners", name: "Velcro, Industrial Strength", unit: "linear ft", currentUnitCost: 2.5, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },
  { category: "Hardware & Fasteners", name: "Wood Screws, Assorted", unit: "box", currentUnitCost: 12.0, sourceNote: "Industry-reference starting estimate -- confirm against your current supplier pricing." },

  // ---------- Custom fabrication & millwork (all real) ----------
  { category: "Custom Fabrication & Millwork", name: "Custom Bar w/ LED Accent Lighting", unit: "unit", currentUnitCost: 1486.0, sourceNote: "Real: observed in 1 real job (Poly Coat USA)." },
  { category: "Custom Fabrication & Millwork", name: "Custom Reception Counter w/ Storage", unit: "unit", currentUnitCost: 1108.0, sourceNote: "Real: observed in 1 real job (Poly Coat USA)." },
  { category: "Custom Fabrication & Millwork", name: "Custom Kiosk w/ LED Lighting", unit: "unit", currentUnitCost: 2560.0, sourceNote: "Real: observed in 1 real job (Poly Coat USA)." },
  { category: "Custom Fabrication & Millwork", name: "Floating Shelf Unit", unit: "unit", currentUnitCost: 816.0, sourceNote: "Real: observed in 1 real job (Brooks Brothers)." },
  { category: "Custom Fabrication & Millwork", name: "Plant Wall Installation", unit: "unit", currentUnitCost: 898.0, sourceNote: "Real: observed in 1 real job (Brooks Brothers)." },
  { category: "Custom Fabrication & Millwork", name: "Hanging Sign Fabric Structure, Small (~8x4)", unit: "unit", currentUnitCost: 1250.0, sourceNote: "Real: observed in 1 real job (Nicklaus Children's Health System)." },
  { category: "Custom Fabrication & Millwork", name: "Hanging Sign Fabric Structure, Large (~12x12x4)", unit: "unit", currentUnitCost: 2700.0, sourceNote: "Real: observed in 1 real job (Yoku Moku)." },
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

  for (const m of MATERIALS) {
    const existing = await db.material.findFirst({ where: { name: m.name } });
    const data = {
      category: m.category,
      unit: m.unit,
      currentUnitCost: m.currentUnitCost,
      sourceNote: m.sourceNote,
    };
    if (existing) {
      await db.material.update({ where: { id: existing.id }, data });
    } else {
      await db.material.create({ data: { name: m.name, ...data } });
    }
  }
  console.log(`Seeded ${MATERIALS.length} materials.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
