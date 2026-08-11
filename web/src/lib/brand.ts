// Expo Convention Contractors brand palette, extracted directly from
// data/ExpCCI-brandguidelines/BRAND IDENTITY GUIDE - EXPO CONVENTION
// CONTRACTORS INC 2025.pdf (section 3.4, exact hex values -- not
// approximated from the printed swatches). Mirrors the CSS custom
// properties in src/app/globals.css -- this module exists because
// @react-pdf/renderer's StyleSheet doesn't read CSS variables, so the PDF
// generator needs plain string constants too.
export const BRAND = {
  black: "#181713",
  white: "#ffffff",
  navy: "#001b6c",
  gray: "#c2c3c9",
  teal: "#19baba",
  tealLight: "#75d6d6",
  tealPale: "#d1f1f1",
  tangerine: "#fbb03b",
  tan: "#fddfb1",
} as const;

// The brand guide's own tagline (section 2.3), title case per its usage
// example ("Let's show off together!").
export const BRAND_TAGLINE = "Let's show off together!";

// The company's own letterhead address/phone, as it appears on every
// historical proposal (data/historical_jobs/xlsx's own "PROPOSAL" sheet
// header) -- the vendor's own public business info, not client data.
export const BRAND_ADDRESS_LINES = [
  "11821 S. Orange Blossom Trail, Suite E., Orlando, FL 32837",
  "Phone: 407.219.3050",
] as const;

// Legal/display name of the company these documents are issued on behalf
// of, per the brand guide's cover page.
export const BRAND_COMPANY_NAME = "Expo Convention Contractors";
