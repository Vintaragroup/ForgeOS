// Shared by the proposal page and the PDF route (src/lib/proposal-pdf.tsx)
// -- both need to pull brandColor/logoUrl out of the same
// templateConfigSnapshot JSON blob.

function stringField(value: unknown, key: string): string | null {
  if (value && typeof value === "object" && key in value) {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === "string" && v !== "" ? v : null;
  }
  return null;
}

function objectField(value: unknown, key: string): unknown {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return null;
}

export function extractBranding(templateConfigSnapshot: unknown): {
  brandColor: string | null;
  logoUrl: string | null;
} {
  const brandingConfig = objectField(templateConfigSnapshot, "brandingConfig");
  return {
    brandColor: stringField(brandingConfig, "color"),
    logoUrl: stringField(brandingConfig, "logoUrl"),
  };
}

// Both fields are stored as one newline-separated textarea value on
// ProposalTemplate.layoutConfig (see catalog/proposal-templates) rather
// than a JSON array -- estimators editing boilerplate copy shouldn't have
// to think about JSON escaping.
function splitLines(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// Professional Services bullet copy has no price of its own -- see
// proposal-pdf.tsx's ProposalPdfProfessionalServices comment for why it's
// only rendered when the estimate itself has a matching section.
export function extractProfessionalServices(templateConfigSnapshot: unknown): { items: string[] } | null {
  const layoutConfig = objectField(templateConfigSnapshot, "layoutConfig");
  const items = splitLines(stringField(layoutConfig, "professionalServicesItems"));
  return items.length > 0 ? { items } : null;
}

export function extractTermsAndConditions(templateConfigSnapshot: unknown): string[] {
  const layoutConfig = objectField(templateConfigSnapshot, "layoutConfig");
  return splitLines(stringField(layoutConfig, "termsAndConditions"));
}

// Informational only -- e.g. "3.5% convenience fee (credit card)" -- never
// changes Total or Grand Total the way the historical Expo CCI proposals
// use it (the fee is disclosed, not baked into the displayed numbers).
export function extractPaymentMethodNote(templateConfigSnapshot: unknown): string | null {
  const layoutConfig = objectField(templateConfigSnapshot, "layoutConfig");
  return stringField(layoutConfig, "paymentMethodNote");
}

