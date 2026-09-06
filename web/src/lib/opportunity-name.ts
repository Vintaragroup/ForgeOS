// Roadmap item #2 (see the estimator's own words): "projects needing
// consistent naming Client Name @ Show Name Year -- Booth # (if known)".
// Opportunity has no single `name` column -- companyName/showName/
// eventStartDate/boothNumber are separate fields (see schema) -- so this
// composes the canonical display label from them on read, instead of
// adding a stored column that could drift out of sync with its sources.
// Plain strings in, plain string out (no Prisma/Decimal types) so this
// is safely importable from both a server component reading real
// Opportunity+Company rows and a "use client" live-preview form reading
// raw FormData values.
export function formatOpportunityLabel(params: {
  companyName: string;
  showName: string;
  eventStartDate: Date | string | null | undefined;
  boothNumber: string | null | undefined;
}): string {
  const companyName = params.companyName.trim();
  const showName = params.showName.trim();
  if (!companyName || !showName) return "";

  // getUTCFullYear, not getFullYear -- an <input type="date"> value is a
  // bare "YYYY-MM-DD" string, which the Date constructor parses as UTC
  // midnight. Reading it back with the local-time accessor would show
  // the wrong year for an early-January show (CES, for one) in any
  // timezone behind UTC, exactly the boundary this convention needs to
  // get right every time, not just usually.
  const year = params.eventStartDate ? new Date(params.eventStartDate).getUTCFullYear() : NaN;
  let label = `${companyName} @ ${showName}`;
  if (!Number.isNaN(year)) label += ` ${year}`;

  const boothNumber = params.boothNumber?.trim();
  if (boothNumber) label += ` – Booth ${boothNumber}`;

  return label;
}
