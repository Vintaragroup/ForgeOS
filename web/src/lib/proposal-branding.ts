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
