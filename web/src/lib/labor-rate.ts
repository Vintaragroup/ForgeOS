// Shared display logic for LaborRate -- used by the catalog list/detail
// pages and the estimate line-item labor-rate picker, so the two don't
// drift on how a tier/union status reads to a human.
export const LABOR_TIER_LABELS: Record<string, string> = {
  STRAIGHT_TIME: "Straight time",
  OVERTIME: "Overtime",
  DOUBLE_TIME: "Double time",
};

export const LABOR_UNION_LABELS: Record<string, string> = { UNION: "Union", NON_UNION: "Non-union" };

// e.g. "Design (DE) — $66.15/hr" for a shop department, or
// "Chicago, IL — Overtime — $240.00/hr" for a show/site market rate.
// Used to label options in the estimate line-item form's labor-rate
// picker (project-type-fields.tsx's sibling for labor).
export function laborRateOptionLabel(r: {
  rateType: string;
  departmentCode: string | null;
  departmentName: string | null;
  city: string | null;
  laborTier: string | null;
  rate: number;
}): string {
  const formatted = `$${r.rate.toFixed(2)}/hr`;
  if (r.rateType === "DEPARTMENT") {
    return `${r.departmentName} (${r.departmentCode}) — ${formatted}`;
  }
  const tier = r.laborTier ? LABOR_TIER_LABELS[r.laborTier] ?? r.laborTier : "";
  return `${r.city} — ${tier} — ${formatted}`;
}
