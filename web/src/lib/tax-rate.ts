// Shared display-label logic for TaxRate -- used everywhere a jurisdiction
// needs a human-readable name: the estimate detail page's picker, the
// estimates/opportunity list annotations, and the proposal PDF/web view's
// "Estimated tax" line.
export function taxRateLabel(t: { state: string; city: string | null; label: string | null }): string {
  return t.label ?? (t.city ? `${t.city}, ${t.state}` : t.state);
}
