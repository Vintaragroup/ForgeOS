// Shared display-label logic for TaxRate -- used everywhere a jurisdiction
// needs a human-readable name: the company/opportunity/estimate pickers,
// list annotations, and the proposal PDF/web view's "Estimated tax" line.
export function taxRateLabel(t: { state: string; city: string | null; label: string | null }): string {
  return t.label ?? (t.city ? `${t.city}, ${t.state}` : t.state);
}

// Adds the percentage to the label for use in a <select> option, e.g.
// "Orlando, FL — 6.50%". Shared by every taxRateId picker (company,
// opportunity, estimate).
export function taxRateOptionLabel(t: {
  state: string;
  city: string | null;
  label: string | null;
  rate: { toNumber(): number };
}): string {
  return `${taxRateLabel(t)} — ${(t.rate.toNumber() * 100).toFixed(2)}%`;
}

// Standard query shape for populating a taxRateId picker's options.
export const TAX_RATE_PICKER_QUERY = {
  where: { deletedAt: null },
  orderBy: [{ state: "asc" as const }, { city: "asc" as const }],
};

// Shown directly under the "Estimated tax" line on the PDF and web
// proposal view -- same wording in both places so the caveat doesn't
// drift between renderers. TaxRate.rate is a snapshot at proposal time,
// not a live feed, so this is the honest caveat for it.
export const TAX_ESTIMATE_DISCLAIMER =
  "Tax is estimated based on the selected jurisdiction as of the proposal date; actual tax due may differ due to rate changes or audit.";
