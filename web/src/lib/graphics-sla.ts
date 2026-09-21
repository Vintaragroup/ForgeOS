// The Graphics department's own delivery commitments, made computable.
//
// Taken verbatim from the Miami SOP (Step 4, "Prioritizing by Show
// Schedule") and her answers of 2026-09-21. Until now ForgeOS modelled
// none of this: the only SLA in the system was a 24h proof-check timer,
// and ArtworkOrder.artDueDate was populated on 0 of 639 production rows,
// so nothing on the Graphics dashboard could say what was late.
//
// A leaf module: pure date arithmetic and lookup tables, no db import, so
// both server code and a client component can use it.

export type MaterialClass = "FABRIC" | "HANGING_SIGN" | "RIGID";

// Business days from production start to the piece being in hand.
//
//   fabrics             5 business days
//   hanging signs      10 business days
//   outsourced rigids   5 business days
//
// The rigid figure is specifically for OUTSOURCED rigids. In-house rigid
// work has no stated turnaround because only Miami can do it, and its own
// sign shop schedules against the show rather than a fixed window.
export const TURNAROUND_BUSINESS_DAYS: Record<MaterialClass, number> = {
  FABRIC: 5,
  HANGING_SIGN: 10,
  RIGID: 5,
};

// Every show graphic must be approved this many business days before
// show-site setup ("All show graphics must be approved within 10 business
// days of show site set-up").
export const APPROVAL_LEAD_BUSINESS_DAYS = 10;

// Between Design & Display and Graphics, a graphic order must be approved
// within this many business days.
export const INTERNAL_APPROVAL_BUSINESS_DAYS = 3;

// Pulling an in-hand date closer than the standard turnaround can attract
// a rush charge. Applied per INVOICE, not per order, and negotiated by the
// Graphics Manager with each vendor -- so this is here to warn, never to
// price anything. Vendor invoices live in NetSuite.
export const RUSH_FEE_TIERS = [0.5, 0.75, 1.0] as const;

// Her material vocabulary, as the data actually spells it: "PVC (White) -
// 1/8\"", "Fabric (Black-Back)", "Vinyl (White)", "1\" Ultraboard - White".
// Hanging signs are identified by the piece, not the material, so the
// graphic's own name/code is checked too.
export function classifyMaterial(material: string | null | undefined, graphicName?: string | null): MaterialClass {
  const name = `${graphicName ?? ""}`.toLowerCase();
  if (name.includes("hanging sign") || name.includes("hanging-sign")) return "HANGING_SIGN";

  const m = `${material ?? ""}`.toLowerCase();
  if (m.includes("fabric") || m.includes("seg")) return "FABRIC";
  // Everything else Expo prints -- PVC, vinyl, foamboard, ultraboard,
  // acrylic -- is rigid for scheduling purposes.
  return "RIGID";
}

// Calendar arithmetic over business days. Weekends only: Expo works
// across five offices in three countries, so there is no one holiday
// calendar to apply, and inventing one would make the dates confidently
// wrong rather than approximately right.
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  const step = days < 0 ? -1 : 1;
  let remaining = Math.abs(days);
  while (remaining > 0) {
    out.setUTCDate(out.getUTCDate() + step);
    const day = out.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return out;
}

export function businessDaysBetween(from: Date, to: Date): number {
  const forward = to.getTime() >= from.getTime();
  const [start, end] = forward ? [from, to] : [to, from];
  const cursor = new Date(start.getTime());
  let count = 0;
  while (cursor.getTime() < end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return forward ? count : -count;
}

// When production has to start for this piece to be in hand on time.
export function productionStartFor(inHandDate: Date, materialClass: MaterialClass): Date {
  return addBusinessDays(inHandDate, -TURNAROUND_BUSINESS_DAYS[materialClass]);
}

// The deadline for approving a show's graphics, from the show's own date.
export function approvalDeadlineFor(showStartDate: Date): Date {
  return addBusinessDays(showStartDate, -APPROVAL_LEAD_BUSINESS_DAYS);
}

export interface SlaStatus {
  materialClass: MaterialClass;
  turnaroundDays: number;
  // Business days from now until the piece is needed. Negative = overdue.
  businessDaysRemaining: number;
  // Not enough time left for this material's standard turnaround, so
  // pulling it in may attract a rush charge -- a warning to pass to the
  // AM/PM, never a price.
  atRiskOfRushFee: boolean;
  overdue: boolean;
}

// Null when there is no in-hand date to judge against, rather than
// guessing one: a piece with no date is unscheduled, not on time.
export function slaStatus(
  order: { inHandDate: Date | null; material: string | null; graphicCode?: string | null },
  now: Date = new Date(),
): SlaStatus | null {
  if (!order.inHandDate) return null;
  const materialClass = classifyMaterial(order.material, order.graphicCode);
  const turnaroundDays = TURNAROUND_BUSINESS_DAYS[materialClass];
  const businessDaysRemaining = businessDaysBetween(now, order.inHandDate);
  return {
    materialClass,
    turnaroundDays,
    businessDaysRemaining,
    atRiskOfRushFee: businessDaysRemaining >= 0 && businessDaysRemaining < turnaroundDays,
    overdue: businessDaysRemaining < 0,
  };
}
