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

// Detail level is captured once, at generateProposal() time, into the same
// JSON snapshot as branding -- so a Proposal always renders with the
// itemized-vs-rolled-up choice the estimator picked when they generated it,
// not whatever the estimate's line items look like today.
export function extractDetailConfig(templateConfigSnapshot: unknown): {
  mode: "summary" | "full";
  sectionNames: string[];
} {
  const detailConfig = objectField(templateConfigSnapshot, "detailConfig");
  const mode = stringField(detailConfig, "mode") === "full" ? "full" : "summary";
  const rawSectionNames =
    detailConfig && typeof detailConfig === "object" && "sectionNames" in detailConfig
      ? (detailConfig as Record<string, unknown>).sectionNames
      : null;
  const sectionNames = Array.isArray(rawSectionNames) ? rawSectionNames.filter((n) => typeof n === "string") : [];
  return { mode, sectionNames };
}

