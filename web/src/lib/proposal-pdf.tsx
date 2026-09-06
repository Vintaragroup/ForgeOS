// B2: a real downloadable PDF, not just the live web page -- sales needs
// something attachable to an email, matching what the old workbook's
// PROPOSAL sheet always produced. @react-pdf/renderer is pure JS (no
// headless-browser/Chromium binary), so it doesn't touch the Docker
// image's footprint the way Puppeteer would have.

import path from "node:path";
import { Document, Page, Text, View, Image as PdfImage, StyleSheet, Font } from "@react-pdf/renderer";
import type { Category, Prisma } from "@/generated/prisma/client";
import type { TimelineResponsibleParty } from "@/generated/prisma/enums";
import { BRAND, BRAND_ADDRESS_LINES, BRAND_COMPANY_NAME, BRAND_TAGLINE } from "@/lib/brand";
import { TAX_ESTIMATE_DISCLAIMER } from "@/lib/tax-rate";
import {
  aggregateByCategory,
  boothGroupsByCategory,
  bucketSubtotal,
  buildTopLevelCategoryViews,
  computeRentalAndServicesTotals,
  standaloneSummaryGroupsByCategory,
  type AggregatedLineItem,
  type BoothGroup,
  type ProposalViewSection,
} from "@/lib/proposal-view-model";
import { computeMarginGrossUp, resolveLineItemMarginPct } from "@/lib/estimate-service";
import { MAX_PROPOSAL_SUMMARY_LENGTH } from "@/lib/proposal-summary-limits";

// The extracted primary black logotype (see web/public/brand -- pulled from
// the brand guide's own "3.1 Logotype" page since we don't have a separate
// vector asset) -- a real file path, not a URL, so @react-pdf/renderer can
// read it straight off disk during server-side PDF rendering.
const LOGO_PATH = path.join(process.cwd(), "public", "brand", "expo-logo-black.png");

Font.registerHyphenationCallback((word) => [word]);

// Brand type is "Bebas Neue Pro SemiExpanded" (data/ExpCCI-brandguidelines) --
// a licensed font we don't have a font file for, so headlines here fall back
// to bold Helvetica rather than risk fetching a substitute font over the
// network at PDF-render time. Color is the primary brand signal in this
// document; see src/lib/brand.ts for the palette source.
//
// Section headers use the guide's own "IMPROPER USES" page (3.8): solid
// black bars with white type are the recurring structural device
// throughout the guide, not a tinted/pastel fill -- so that's what
// distinguishes a category header here, with a small rotating accent
// swatch (navy/teal/tangerine/tan, the guide's own secondary palette) for
// telling adjacent categories apart at a glance.
const SECTION_ACCENTS = [BRAND.navy, BRAND.teal, BRAND.tangerine, BRAND.tan];

const styles = StyleSheet.create({
  // paddingTop/paddingBottom reserve room for the fixed running header
  // (pages 2+ only, see runningHeader) and fixed footer (every page) so
  // flowing content never collides with either -- costs the cover page a
  // bit of unused top space since it uses the same page-wide padding for
  // its own non-fixed header instead, which reads fine as cover-page
  // breathing room (see the historical Expo CCI proposals' own page 1).
  page: {
    paddingTop: 84,
    paddingBottom: 60,
    paddingHorizontal: 48,
    fontSize: 10,
    fontFamily: "Helvetica",
    color: BRAND.black,
  },
  runningHeader: { position: "absolute", top: 28, left: 48, right: 48 },
  runningHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
    paddingBottom: 8,
  },
  runningHeaderLogo: { height: 14, width: 41 },
  runningHeaderShowName: {
    fontSize: 9,
    fontWeight: 700,
    color: BRAND.navy,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  runningHeaderLabel: { fontSize: 8, color: BRAND.teal, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 },
  accentBar: { height: 6, marginBottom: 20 },
  issuerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 },
  issuerLogo: { height: 20, width: 59 },
  issuerAddress: { marginTop: 6, fontSize: 8, color: "#737373", lineHeight: 1.5 },
  docType: { fontSize: 8, color: BRAND.teal, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1.5 },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 24,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
  },
  company: { fontSize: 9, color: BRAND.navy, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 },
  showName: { fontSize: 18, fontWeight: 700, marginTop: 3 },
  templateLabel: { fontSize: 8, color: "#737373", textAlign: "right" },
  templateName: { fontSize: 10, fontWeight: 700, textAlign: "right", marginTop: 2 },
  section: { marginBottom: 14 },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: BRAND.black,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  // flex: 1 (flexGrow+flexShrink+flexBasis:0%), not just flexShrink: 1 --
  // flexShrink alone leaves flexBasis at "auto" (content size), and yoga
  // measures/wraps this Text before it's reserved room for its sibling
  // total, so the total's own space still gets overlapped by a wrapped
  // second line even though wrapping itself now happens (confirmed live:
  // exactly this happened before this fix). flex: 1 forces yoga to size
  // the total first, then give this element only the true remainder to
  // wrap within.
  sectionHeaderLeft: { flexDirection: "row", alignItems: "center", flex: 1, marginRight: 8 },
  sectionAccentSwatch: { width: 7, height: 7, marginRight: 6, flexShrink: 0 },
  sectionHeaderText: {
    flex: 1,
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.75,
    color: BRAND.white,
  },
  sectionHeaderTotal: { flexShrink: 0, fontSize: 8, fontWeight: 700, color: BRAND.white },
  // A category with children (currently just Custom Build > Structure --
  // see line-item-category.ts's CATEGORY_PARENT) renders its own items
  // first, then each child nested underneath via subsection/
  // subsectionHeaderRow -- a lighter, indented header so it reads as
  // "part of" the parent rather than a co-equal top-level category.
  subsection: { marginLeft: 10, marginBottom: 10 },
  subsectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#efefef",
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  // Same flex: 1 fix as sectionHeaderText above.
  subsectionHeaderText: {
    flex: 1,
    marginRight: 8,
    fontSize: 7.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: BRAND.black,
  },
  subsectionHeaderTotal: { flexShrink: 0, fontSize: 7.5, fontWeight: 700, color: BRAND.black },
  // "Custom Rental" umbrella -> booth (H2) -> element type (H3) -- a
  // third grouping axis alongside the category/subcategory one above,
  // used only for line items with a known booth (groupBoothLineItems).
  // Booth is the PRIMARY axis here (unlike subsection, a category's minor
  // child), so it gets its own bolder treatment one step down from the
  // umbrella's black bar rather than reusing subsectionHeaderRow's
  // lighter gray, which would read as equally minor.
  boothSection: { marginLeft: 6, marginBottom: 10 },
  boothHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: BRAND.navy,
    paddingVertical: 5,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  // flex: 1 (not flexShrink alone, and not a fixed/percentage width) --
  // without it, this Text and boothHeaderTotal are two auto-sized siblings
  // in a flexDirection: "row" parent, and a long custom boothDescription (a
  // real, reported production bug -- "Custom Build headings cut off the
  // description") could overflow past the total. flexShrink: 1 alone
  // wraps the text, but leaves flexBasis at "auto" (content size), so yoga
  // still measures/wraps it BEFORE reserving boothHeaderTotal's own width --
  // confirmed live: the text wrapped, but its second line then rendered
  // straight through/under the total instead of stopping short of it.
  // flex: 1 (flexBasis 0%) forces yoga to size boothHeaderTotal
  // (flexShrink: 0 below) first, then give this Text only the true
  // remainder to wrap within.
  boothHeaderText: {
    flex: 1,
    marginRight: 8,
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: BRAND.white,
  },
  boothHeaderTotal: { flexShrink: 0, fontSize: 8, fontWeight: 700, color: BRAND.white },
  // Body text for all three copy tiers (Category/Booth/Element -- see
  // EstimateCategorySummary and EstimateSection.boothSummary/elementSummary's
  // own schema comments) -- same font size/line-height as
  // professionalServicesItem below, the other place this document already
  // sets prose rather than a table row.
  proposalSummaryText: { fontSize: 8.5, lineHeight: 1.6, marginBottom: 10, color: "#333" },
  elementTypeSection: { marginLeft: 10, marginBottom: 8 },
  elementTypeHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#efefef",
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  // Same flex: 1 fix as boothHeaderText above, for the same reason.
  elementTypeHeaderText: {
    flex: 1,
    marginRight: 8,
    fontSize: 7.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: BRAND.black,
  },
  elementTypeHeaderTotal: { flexShrink: 0, fontSize: 7.5, fontWeight: 700, color: BRAND.black },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: BRAND.black,
    paddingBottom: 3,
    paddingHorizontal: 6,
    marginBottom: 2,
  },
  tableRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#f5f5f5",
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  colDescription: { width: "48%" },
  // A compound assembly's booth number (see AggregatedLineItem.boothLabel)
  // reads as the item's actual name -- the raw spec text underneath it is
  // supporting detail, not the primary label a client scans for.
  itemBoothLabel: { fontSize: 8.5, fontWeight: 700, color: BRAND.navy, marginBottom: 1 },
  colQty: { width: "14%", textAlign: "right" },
  colUnit: { width: "13%", textAlign: "right" },
  colTotal: { width: "25%", textAlign: "right" },
  // Narrower variants used only when data.showCost is true (the internal
  // Preview PDF), making room for a real second amount column instead of
  // the single Total -- see colCost/colPrice below. Never used on the
  // real client Proposal PDF, which keeps the original 4-column widths.
  colDescriptionDual: { width: "36%" },
  colQtyDual: { width: "11%", textAlign: "right" },
  colUnitDual: { width: "10%", textAlign: "right" },
  // Muted color is the only visual cue distinguishing Cost from Price --
  // deliberately not a background tint or border, which would fight the
  // section accent colors already carrying meaning on this page.
  colCost: { width: "20%", textAlign: "right", color: "#8a8a8a" },
  colPrice: { width: "23%", textAlign: "right" },
  // A $0.00 the client already owns/supplies, not "not yet priced" -- see
  // ProposalViewLineItem.isClientOwned's comment.
  clientOwnedLabel: { fontStyle: "italic", color: "#737373" },
  // Nested inline span ahead of a header/subtotal bar's price (see
  // amountContent below) -- these bars were never a column grid, just one
  // right-aligned total, so "cost and price side by side" here means a
  // smaller/lighter prefix within the same <Text> node rather than a
  // parallel grid for every differently-colored bar on the page.
  costPrefixSpan: { fontSize: 7, fontWeight: 400 },
  // Summary-only categories (see isSummary below) skip the priced table
  // entirely but still list what's actually in the category -- same
  // bullet treatment as professionalServicesItem/projectScopeItem, just a
  // different section.
  summaryListItem: { fontSize: 8.5, lineHeight: 1.6, color: "#404040", paddingHorizontal: 8, marginBottom: 2 },
  headerCell: { color: BRAND.black, fontSize: 8, textTransform: "uppercase", fontWeight: 700 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    borderTopWidth: 1.5,
    borderTopColor: BRAND.navy,
    paddingTop: 12,
    marginTop: 4,
  },
  totalBlock: { alignItems: "flex-end" },
  totalLabel: { fontSize: 8, color: "#737373" },
  totalValue: { fontSize: 20, fontWeight: 700, marginTop: 2, color: BRAND.navy },
  // Only rendered when data.showCost -- a second, deliberately smaller/
  // muted block beside Grand total so the marked-up figure stays the
  // visual headline even while cost sits right next to it for reference.
  totalCostBlock: { marginRight: 24 },
  totalCostValue: { fontSize: 14, fontWeight: 700, marginTop: 2, color: "#737373" },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 48,
    right: 48,
    fontSize: 8,
    color: "#a3a3a3",
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    paddingTop: 8,
  },
  footerBottomRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  contactLine: { fontSize: 9, color: "#404040", marginTop: 2 },
  // The template's own configured logo (brandingConfig.logoUrl) -- distinct
  // from the fixed Expo logotype in issuerLogo above. Bounded, not fixed,
  // since a client-supplied logo's own aspect ratio is unknown.
  templateLogo: { maxHeight: 28, maxWidth: 140, marginBottom: 4 },
  projectDescriptionSection: { marginBottom: 20 },
  projectVenue: { fontSize: 9, fontWeight: 700, color: BRAND.black, marginTop: 6, marginBottom: 4, paddingHorizontal: 8 },
  projectScopeItem: { fontSize: 8.5, lineHeight: 1.6, color: "#404040", paddingHorizontal: 8, marginBottom: 2 },
  timelineSection: { marginBottom: 20 },
  timelineRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#f5f5f5",
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  timelineDate: { width: "22%", fontSize: 9, fontWeight: 700 },
  timelineLabel: { width: "78%", fontSize: 9 },
  serviceRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#f5f5f5",
    paddingVertical: 5,
    paddingHorizontal: 6,
  },
  serviceDescription: { width: "75%", lineHeight: 1.4 },
  serviceTotal: { width: "25%", textAlign: "right", fontWeight: 700 },
  // Dual (showCost) variants, same reasoning as colDescriptionDual etc. above.
  serviceDescriptionDual: { width: "50%", lineHeight: 1.4 },
  serviceCost: { width: "22%", textAlign: "right", color: "#8a8a8a" },
  servicePrice: { width: "28%", textAlign: "right", fontWeight: 700 },
  professionalServicesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  professionalServicesList: { width: "100%" },
  professionalServicesItem: { fontSize: 8.5, lineHeight: 1.6 },
  subtotalsBlock: { alignItems: "flex-end", marginTop: 8 },
  subtotalsRow: { flexDirection: "row", justifyContent: "flex-end", marginTop: 2 },
  subtotalsRowLabel: { fontSize: 9, color: "#737373", marginRight: 16 },
  subtotalsRowValue: { fontSize: 9, fontWeight: 700, width: 80, textAlign: "right" },
  taxDisclaimer: { fontSize: 7, fontStyle: "italic", color: "#a3a3a3", marginTop: 2, maxWidth: 280, textAlign: "right" },
  // Informational note only -- see paymentMethodNote's own comment on
  // ProposalPdfData. Right-aligned to sit with the totals column it
  // precedes, not a table row of its own.
  paymentMethodNote: { alignItems: "flex-end", marginTop: 10 },
  paymentMethodLabel: { fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: BRAND.black },
  paymentMethodText: { fontSize: 8, color: "#737373", marginTop: 2, maxWidth: 260, textAlign: "right" },
  // Tight enough that a normal 21-clause terms block (matching the
  // historical Expo CCI proposals' own terms page) fits on one page
  // together with the signature blocks, instead of pushing them onto an
  // otherwise-blank following page -- the historical documents keep terms
  // and signatures on a single dense page at exactly this kind of small
  // print, not a design compromise unique to ForgeOS.
  termsSection: { marginTop: 12 },
  termsHeading: {
    fontSize: 11,
    fontWeight: 700,
    marginBottom: 8,
    color: BRAND.navy,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  termsClause: { fontSize: 7.5, lineHeight: 1.35, marginBottom: 4, color: "#404040" },
  termsClauseNumber: { fontWeight: 700 },
  signatureSection: { marginTop: 16, flexDirection: "row", justifyContent: "space-between" },
  signatureBlock: { width: "45%" },
  signatureLine: { borderTopWidth: 1, borderTopColor: BRAND.black, marginTop: 20, paddingTop: 4 },
  signatureLabel: { fontSize: 8, color: "#737373" },
});

// Intl.NumberFormat, not template-literal toFixed(2) -- a real job total
// like $58,311.18 rendered as "$58311.18" with no thousands separator on
// every dollar figure over four digits.
const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const QTY_FORMATTER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function moneyFromNumber(n: number): string {
  return CURRENCY_FORMATTER.format(n);
}

function formatQtyNumber(n: number): string {
  return QTY_FORMATTER.format(n);
}

// The authoritative safety net for the wrap={false} overflow bug (see
// proposal-summary-limits.ts): estimate-service.ts rejects a new summary
// over the cap at write time, but that can't retroactively fix a summary
// already stored before this cap existed. Truncating here guarantees this
// document can never render an oversized header+summary block regardless
// of what's actually in the database.
function truncateProposalSummary(text: string): string {
  if (text.length <= MAX_PROPOSAL_SUMMARY_LENGTH) return text;
  return `${text.slice(0, MAX_PROPOSAL_SUMMARY_LENGTH).trimEnd()}…`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Compact "Cost $X → " prefix ahead of the price, nested inside the same
// <Text> node rather than a second column -- see costPrefixSpan's own
// comment on why header/subtotal bars use this instead of a grid. When
// showCost is false (the real client Proposal), this is just the price,
// unchanged from what a plain moneyFromNumber(price) call would render.
function amountContent(cost: number, price: number, showCost: boolean) {
  if (!showCost) return moneyFromNumber(price);
  return (
    <>
      <Text style={styles.costPrefixSpan}>Cost {moneyFromNumber(cost)} → </Text>
      {moneyFromNumber(price)}
    </>
  );
}

export interface ProposalPdfTimelineEntry {
  label: string;
  date: Date;
  responsibleParty: TimelineResponsibleParty;
}

// Descriptive scope-of-services copy only -- no price of its own. The
// dollar amount comes from real line items tagged with the "Professional
// Services" category (same mechanism as Labor/Shipping: actual line
// items, so the total already flows into this document's own Grand Total
// correctly). This is boilerplate text injected above that category's
// items when any exist; if none do, there's nothing to attach the copy
// to, so it's simply not rendered.
export interface ProposalPdfProfessionalServices {
  items: string[];
}

export interface ProposalPdfData {
  companyName: string;
  companyAddress: string | null;
  contactName: string | null;
  contactEmail: string | null;
  showName: string;
  templateName: string;
  brandColor: string | null;
  logoUrl: string | null;
  proposalDate: Date;
  timeline: ProposalPdfTimelineEntry[];
  venue: string | null;
  scopeSummary: string[];
  sections: ProposalViewSection[];
  // Live catalog (db.category.findMany, ordered by sortOrder) -- drives
  // section order/hierarchy (aggregateByCategory/buildTopLevelCategoryViews)
  // and which categories render lump-sum / roll into Show Services below.
  // Caller (preview-pdf/route.ts) may have already reordered this array
  // per the modal's own category-reorder controls -- this component just
  // renders whatever order it's given, same as it always has.
  categories: Category[];
  // Ephemeral, per-export view options from the Preview PDF modal
  // (proposal-preview-modal.tsx) -- never persisted, both keyed by
  // Category NAME (not id) since that's what aggregateByCategory's own
  // buckets are keyed on. A category in summaryCategoryNames renders its
  // header + subtotal only, no item rows; a category in
  // hidePricingCategoryNames blanks its own subtotal and every one of its
  // line items' Total cell (same visual treatment as the existing
  // isClientOwned redaction, just triggered per-category instead of
  // per-line) -- Grand Total / Rental-Services totals below are computed
  // from the full, real buckets regardless, so hiding a category's
  // breakdown never changes the bottom-line number.
  hidePricingCategoryNames?: ReadonlySet<string>;
  summaryCategoryNames?: ReadonlySet<string>;
  // Top tier of the three-level Proposal PDF copy system -- see
  // EstimateCategorySummary's own schema comment. Keyed by category NAME,
  // same convention as the two Sets above; only categories with an
  // approved (non-null) summary appear here.
  categorySummaries?: ReadonlyMap<string, string>;
  // Defaults true on the internal Preview PDF (preview-pdf/route.ts):
  // every dollar figure renders as Cost alongside the marked-up Price, so
  // an estimator can sanity-check margin math before a version is locked
  // -- though that route's own ?showCost=0 lets an estimator switch to a
  // price-only preview on demand, without needing the version locked or
  // approved first. Always false on the real, client-facing Proposal PDF
  // (proposals/[id]/pdf/route.ts), not configurable there: only the
  // marked-up Price ever renders -- cost never reaches the client, no
  // matter what a query string says. Neither route can omit this field;
  // there's no default that's safe for both.
  showCost: boolean;
  professionalServices: ProposalPdfProfessionalServices | null;
  termsAndConditions: string[];
  paymentMethodNote: string | null;
  // Informational only, same as paymentMethodNote -- never changes
  // grandTotal. label is a display string (e.g. "Orlando, FL"); rate is a
  // decimal fraction (0.065 for 6.5%), multiplied against the already-
  // computed rentalTotal (Total Taxable) to get the estimated dollar
  // amount. No real tax-rate API involved -- see catalog/tax-rates.
  taxRate: { label: string; rate: number } | null;
  // Deliberately NOT EstimateVersion.grandTotal -- this document computes
  // its own Grand Total (documentGrandTotal below) from the exact same
  // buckets its itemized rows come from, so hiding a line item or booth
  // from just this document can never desync the two. The estimate's own
  // stored grandTotal (shown everywhere else in the app) stays exactly
  // what it would be with nothing hidden -- see includeInProposal's own
  // schema comment for why that's a real requirement, not an oversight.
  marginTargetPct: Prisma.Decimal;
  categoryMarginOverrides: { categoryId: string; marginPct: Prisma.Decimal }[];
  sentAt: Date | null;
  signedAt: Date | null;
  signedByName: string | null;
  signedByTitle: string | null;
}

export function ProposalPdfDocument({ data }: { data: ProposalPdfData }) {
  // buckets/topLevelCategories run against the FULL, unfiltered
  // data.sections -- a tagged booth's items already resolve into Rental
  // Structures/Custom Components directly (resolveEffectiveCategory), so
  // there's nothing left to split out into a separate block; an untagged
  // booth's items stay under their own raw category exactly as before.
  const buckets = aggregateByCategory(data.sections, data.categories);
  // Every AggregatedLineItem.totalCost is raw cost (see proposal-view-
  // model.ts -- no margin is ever applied there by design). Different
  // categories can now carry different margins (CategoryMarginOverride),
  // so a single grandTotal/totalCost ratio can no longer represent "the"
  // margin -- sellForCategory grosses up at exactly the rate
  // estimate-service.ts's own computeVersionTotals used for that category
  // (its override if set, else data.marginTargetPct), via the identical
  // resolveLineItemMarginPct/computeMarginGrossUp functions. Since every
  // AggregatedLineItem in one bucket already shares that bucket's own
  // resolved category name, summing sellForCategory(item.totalCost,
  // bucket.name) over every item reproduces exactly what
  // EstimateVersion.grandTotal would be if nothing were hidden from this
  // document -- documentGrandTotal below sums the same way over whatever
  // buckets actually survive filtering, so this document's own total is
  // always internally consistent with its own itemized rows, hidden
  // items or not.
  const marginOverridesByCategoryId = new Map(data.categoryMarginOverrides.map((o) => [o.categoryId, o.marginPct]));
  // Total raw cost across every bucket -- only used for the "Total cost"
  // figure on the internal (showCost) preview, unrelated to sellForCategory
  // below since cost never varies by margin.
  const totalCostSum = buckets.reduce((sum, b) => sum + bucketSubtotal(b.items), 0);
  const sellForCategory = (cost: number, categoryName: string) => {
    const marginPct = resolveLineItemMarginPct(categoryName, data.categories, marginOverridesByCategoryId, data.marginTargetPct);
    return computeMarginGrossUp(cost, marginPct).toNumber();
  };
  const topLevelCategories = buildTopLevelCategoryViews(buckets, data.categories);
  const showServiceCategoryNames = new Set(data.categories.filter((c) => c.isShowService).map((c) => c.name));
  const lumpSumCategoryNames = new Set(data.categories.filter((c) => c.isLumpSum).map((c) => c.name));
  const hidePricingCategoryNames = data.hidePricingCategoryNames ?? new Set<string>();
  const summaryCategoryNames = data.summaryCategoryNames ?? new Set<string>();

  // Component grouping (booth -> element type -> line items) lives inside
  // whichever category each of a tagged booth's own items resolved into
  // -- not one of two fixed buckets regardless of what they actually are
  // -- so a booth's Structure content and its Audio/Visual content each
  // surface under their own tab. See resolveEffectiveCategory and
  // boothGroupsByCategory. An untagged booth (buildType still null)
  // contributes no booth groups and keeps rendering flat under its own
  // raw category, unchanged.
  const boothGroupsByCategoryName = boothGroupsByCategory(data.sections, data.categories);
  // A summarized standalone section (see its own comment) renders through
  // this exact same booth-shaped machinery -- merged in here rather than
  // handled as a separate lookup, so every call site below (top-level and
  // per-child alike) picks it up automatically, same as a real booth.
  const standaloneSummaryGroupsByCategoryName = standaloneSummaryGroupsByCategory(data.sections, data.categories);
  const boothGroupsForCategory = (categoryName: string): BoothGroup[] => [
    ...(boothGroupsByCategoryName.get(categoryName) ?? []),
    ...(standaloneSummaryGroupsByCategoryName.get(categoryName) ?? []),
  ];

  // Every distinct aggregated item renders as its own row, always -- no
  // detail-mode toggle, no "Includes: A, B, C" collapse. Cross-booth
  // aggregation (see aggregateByCategory) already did the summarizing;
  // a second collapse on top of that either hid real quantities behind a
  // vague blurb or, worse, silently dropped distinct booths that happened
  // to share a description's first line. Matches every historical Expo
  // CCI proposal, which itemizes every component with a real qty/total,
  // never a rolled-up description.
  // hidePrice is a per-category view option (see ProposalPdfData's own
  // comment), not a per-line one like isClientOwned -- every row in a
  // hide-pricing category blanks the same way, regardless of that row's
  // own isClientOwned value (a client-owned row already reads "Client
  // Owned" either way, so hidePrice only changes anything for a normally-
  // priced row).
  const renderBody = (items: AggregatedLineItem[], categoryName: string, hidePrice = false) => (
    <>
      {items.map((li) => (
        <View key={li.key} style={styles.tableRow} wrap={false}>
          <View style={data.showCost ? styles.colDescriptionDual : styles.colDescription}>
            {li.boothLabel && <Text style={styles.itemBoothLabel}>{li.boothLabel}</Text>}
            <Text>{li.description}</Text>
          </View>
          <Text style={data.showCost ? styles.colQtyDual : styles.colQty}>{formatQtyNumber(li.qty)}</Text>
          <Text style={data.showCost ? styles.colUnitDual : styles.colUnit}>{li.unit ?? ""}</Text>
          {data.showCost && (
            <Text style={{ ...styles.colCost, ...(li.isClientOwned || hidePrice ? styles.clientOwnedLabel : {}) }}>
              {li.isClientOwned ? "Client Owned" : hidePrice ? "" : moneyFromNumber(li.totalCost)}
            </Text>
          )}
          <Text
            style={{
              ...(data.showCost ? styles.colPrice : styles.colTotal),
              ...(li.isClientOwned || hidePrice ? styles.clientOwnedLabel : {}),
            }}
          >
            {li.isClientOwned ? "Client Owned" : hidePrice ? "" : moneyFromNumber(sellForCategory(li.totalCost, categoryName))}
          </Text>
        </View>
      ))}
    </>
  );

  // Summary-only categories (isSummary below) skip renderBody/
  // renderServiceBody entirely -- but rendering nothing at all besides the
  // header/subtotal left a client with no idea what the category even
  // contains. This lists each item's own description as a plain bullet,
  // no qty/unit/price columns, so "summary" still says what's included
  // without turning back into the full priced table.
  const renderSummaryBody = (items: AggregatedLineItem[]) => (
    <>
      {items.map((li) => (
        <Text key={li.key} style={styles.summaryListItem}>
          • {li.boothLabel ? `${li.boothLabel} — ${li.description}` : li.description}
        </Text>
      ))}
    </>
  );

  const renderServiceBody = (items: AggregatedLineItem[], categoryName: string, hidePrice = false) => (
    <>
      {items.map((li) => (
        <View key={li.key} style={styles.serviceRow} wrap={false}>
          <Text style={data.showCost ? styles.serviceDescriptionDual : styles.serviceDescription}>
            {li.description}
          </Text>
          {data.showCost && (
            <Text style={{ ...styles.serviceCost, ...(li.isClientOwned || hidePrice ? styles.clientOwnedLabel : {}) }}>
              {li.isClientOwned ? "Client Owned" : hidePrice ? "" : moneyFromNumber(li.totalCost)}
            </Text>
          )}
          <Text
            style={{
              ...(data.showCost ? styles.servicePrice : styles.serviceTotal),
              ...(li.isClientOwned || hidePrice ? styles.clientOwnedLabel : {}),
            }}
          >
            {li.isClientOwned ? "Client Owned" : hidePrice ? "" : moneyFromNumber(sellForCategory(li.totalCost, categoryName))}
          </Text>
        </View>
      ))}
    </>
  );

  // Shared by the top-level category loop and each of its Method-split
  // children below -- boothGroupsByCategory keys its output by whichever
  // EFFECTIVE category (resolveEffectiveCategory) a tagged booth's items
  // actually resolved into, which is the COMPOSED leaf name (e.g.
  // "Audio/Visual - Rental") for any Type that has a Method split, not
  // the plain top-level name. A booth living entirely under one such
  // split-leaf category used to never be looked up at all -- only the
  // top-level name was ever passed to boothGroupsForCategory -- so it
  // silently fell all the way through to the flat per-child render below
  // with no booth heading, no boothSummary, and no summarizeOnProposal
  // effect. Confirmed live: a real booth ("Large LED Display Wall",
  // resolved into "Audio/Visual - Rental") rendered correctly in the Line
  // Items tab but as a flat, unlabeled item dump on the actual Proposal
  // PDF specifically.
  const renderBoothGroups = (boothGroups: BoothGroup[], categoryName: string, hidePrice: boolean, isSummary: boolean, isServiceStyle: boolean) => (
    <>
      {boothGroups.map((booth) => (
        <View key={booth.boothLabel} style={styles.boothSection}>
          {/* wrap={false}, not minPresenceAhead, on this outer pair --
              minPresenceAhead only checks whether the HEADER ROW itself has
              room; boothSummary is a separate sibling Text, so a header that
              clears the threshold could still leave its own summary
              orphaned onto the next page. wrap={false} measures the header
              + summary together as one atomic block and moves the whole
              thing if it doesn't fit, same mechanism this file already uses
              for a line-item row/the signature block. */}
          <View wrap={false}>
            <View style={styles.boothHeaderRow}>
              <Text style={styles.boothHeaderText}>{booth.boothDescription ?? booth.boothLabel}</Text>
              <Text style={styles.boothHeaderTotal}>
                {hidePrice ? "" : amountContent(booth.subtotal, sellForCategory(booth.subtotal, categoryName), data.showCost)}
              </Text>
            </View>
            {/* Middle tier -- see EstimateSection.boothSummary's own schema
                comment. Always shown when written, independent of
                summarizeOnProposal: booth.subtotal already includes every
                item regardless, so the total stays correct whichever way
                that flag is set, and this copy is additive context, not a
                replacement for anything. */}
            {booth.boothSummary && (
              <Text style={styles.proposalSummaryText}>{truncateProposalSummary(booth.boothSummary)}</Text>
            )}
          </View>
          {booth.elementGroups.map((group) => (
            <View key={group.elementType} style={styles.elementTypeSection}>
              <View wrap={false}>
                <View style={styles.elementTypeHeaderRow}>
                  <Text style={styles.elementTypeHeaderText}>{group.elementType}</Text>
                  <Text style={styles.elementTypeHeaderTotal}>
                    {hidePrice ? "" : amountContent(group.subtotal, sellForCategory(group.subtotal, categoryName), data.showCost)}
                  </Text>
                </View>
                {/* Bottom tier -- same "always shown" reasoning as
                    boothSummary above. */}
                {group.elementSummary && (
                  <Text style={styles.proposalSummaryText}>{truncateProposalSummary(group.elementSummary)}</Text>
                )}
              </View>
              {/* summarizeOnProposal's only remaining job: skip just the
                  itemized rows below. See EstimateSection.summarizeOnProposal's
                  own schema comment. */}
              {!booth.summarizeOnProposal &&
                (isSummary
                  ? renderSummaryBody(group.items)
                  : isServiceStyle
                    ? renderServiceBody(group.items, categoryName, hidePrice)
                    : renderBody(group.items, categoryName, hidePrice))}
            </View>
          ))}
        </View>
      ))}
    </>
  );

  const { rentalTotal, servicesTotal, hasServiceSplit } = computeRentalAndServicesTotals(
    buckets,
    showServiceCategoryNames,
  );
  // Sums each bucket's own grossed-up (per-that-category's-margin) amount,
  // rather than grossing up the pre-summed raw-cost total once -- correct
  // once buckets can carry different margins. rentalTotal/servicesTotal
  // (raw cost, above) are kept for the Cost half of the Cost -> Price
  // display when data.showCost is true.
  const sellRentalTotal = buckets
    .filter((b) => !showServiceCategoryNames.has(b.name))
    .reduce((sum, b) => sum + sellForCategory(bucketSubtotal(b.items), b.name), 0);
  const sellServicesTotal = buckets
    .filter((b) => showServiceCategoryNames.has(b.name))
    .reduce((sum, b) => sum + sellForCategory(bucketSubtotal(b.items), b.name), 0);
  // NOT data.grandTotal (EstimateVersion.grandTotal, computed server-side
  // over every real line item) -- that figure is deliberately never
  // affected by a line item or booth being hidden from just this
  // document (the estimate's own internal totals/margins have to stay
  // exactly what they'd be if nothing were hidden, confirmed live as a
  // real requirement, not an incidental side effect to accept). This
  // document's OWN Grand Total has the opposite job: it has to equal
  // whatever is actually itemized on the page above it, hidden or not,
  // or the PDF is internally inconsistent -- a real bug the moment
  // includeInProposal could actually remove something from buckets,
  // unlike hidePricingCategoryNames/summaryCategoryNames above, which
  // only ever blank a display, never remove an item from these sums.
  const documentGrandTotal = sellRentalTotal + sellServicesTotal;

  return (
    <Document title={`Proposal — ${data.showName}`}>
      <Page size="LETTER" style={styles.page}>
        <View
          style={styles.runningHeader}
          fixed
          render={({ pageNumber }) =>
            pageNumber === 1 ? null : (
              <View style={styles.runningHeaderRow}>
                <PdfImage src={LOGO_PATH} style={styles.runningHeaderLogo} />
                <Text style={styles.runningHeaderShowName}>{data.showName}</Text>
                <Text style={styles.runningHeaderLabel}>Proposal</Text>
              </View>
            )
          }
        />
        <View style={[styles.accentBar, { backgroundColor: data.brandColor ?? BRAND.navy }]} />
        <View style={styles.issuerRow}>
          <View>
            <PdfImage src={LOGO_PATH} style={styles.issuerLogo} />
            <View style={styles.issuerAddress}>
              {BRAND_ADDRESS_LINES.map((line) => (
                <Text key={line}>{line}</Text>
              ))}
            </View>
          </View>
          <Text style={styles.docType}>Proposal</Text>
        </View>
        <View style={styles.headerRow}>
          <View>
            {data.logoUrl && <PdfImage src={data.logoUrl} style={styles.templateLogo} />}
            <Text style={styles.company}>Prepared for {data.companyName}</Text>
            {data.companyAddress && <Text style={styles.contactLine}>{data.companyAddress}</Text>}
            {(data.contactName || data.contactEmail) && (
              <Text style={styles.contactLine}>
                {[data.contactName, data.contactEmail].filter(Boolean).join(" — ")}
              </Text>
            )}
            <Text style={styles.showName}>{data.showName}</Text>
          </View>
          <View>
            <Text style={styles.templateLabel}>Proposal date</Text>
            <Text style={styles.templateName}>{formatDate(data.proposalDate)}</Text>
          </View>
        </View>

        {(data.venue || data.scopeSummary.length > 0) && (
          <View style={styles.projectDescriptionSection}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeaderText}>Project Description</Text>
            </View>
            {data.venue && <Text style={styles.projectVenue}>Venue: {data.venue}</Text>}
            {data.scopeSummary.map((item, i) => (
              <Text key={i} style={styles.projectScopeItem}>
                • {item}
              </Text>
            ))}
          </View>
        )}

        {data.timeline.length > 0 && (
          <View style={styles.timelineSection}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeaderText}>Timeline</Text>
            </View>
            {data.timeline.map((entry, i) => (
              <View key={`${entry.label}-${i}`} style={styles.timelineRow} wrap={false}>
                <Text style={styles.timelineDate}>{formatDate(entry.date)}</Text>
                <Text style={styles.timelineLabel}>
                  {/* "EXPO CCI" -- the real company abbreviation (brand.ts's
                      BRAND_COMPANY_NAME, "Expo Convention Contractors"),
                      not "EXPO CC". Confirmed live: this line dropped the
                      trailing "I" on the client-facing PDF. */}
                  {entry.label} ({entry.responsibleParty === "CLIENT" ? "Client" : "EXPO CCI"} Responsibility)
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Cover content (header, timeline, project description) always stays
            on its own page(s) -- quote details start fresh regardless of how
            much or little cover content there is, so the pricing table never
            competes with it for room mid-page. */}
        <View style={styles.tableHeaderRow} break>
          <Text style={[data.showCost ? styles.colDescriptionDual : styles.colDescription, styles.headerCell]}>
            Description
          </Text>
          <Text style={[data.showCost ? styles.colQtyDual : styles.colQty, styles.headerCell]}>Qty</Text>
          <Text style={[data.showCost ? styles.colUnitDual : styles.colUnit, styles.headerCell]}>Unit</Text>
          {data.showCost && <Text style={[styles.colCost, styles.headerCell]}>Cost</Text>}
          <Text style={[data.showCost ? styles.colPrice : styles.colTotal, styles.headerCell]}>
            {data.showCost ? "Price" : "Total"}
          </Text>
        </View>

        {topLevelCategories.map(({ name: categoryName, ownItems, children }, categoryIndex) => {
          const accent = SECTION_ACCENTS[categoryIndex % SECTION_ACCENTS.length];
          const isServiceStyle = lumpSumCategoryNames.has(categoryName);
          const isSummary = summaryCategoryNames.has(categoryName);
          const hidePrice = hidePricingCategoryNames.has(categoryName);

          // A tagged booth's items already resolved into this exact
          // category's bucket (resolveEffectiveCategory) -- boothGroups
          // renders them grouped by booth -> element type instead of flat,
          // reusing the exact hierarchy the (now-removed) standalone
          // Custom Rental block used to render on its own. Any of this
          // category's items that AREN'T booth-linked (added directly to
          // the category, or an untagged booth still on its raw category)
          // still render flat below/alongside, unchanged.
          const boothGroups = boothGroupsForCategory(categoryName);
          const hasBoothGroups = boothGroups.length > 0;
          const flatOwnItems = hasBoothGroups ? ownItems.filter((li) => !li.boothLabel) : ownItems;
          // Each Method-split child (e.g. "Audio/Visual - Rental") is its
          // own effective category in boothGroupsByCategory's own terms --
          // resolveEffectiveCategory composes the Method suffix onto a
          // tagged booth's leaf category before that booth ever reaches
          // this file, so a booth living entirely under one such child
          // must be looked up by the CHILD's own name, not the top-level
          // categoryName above (see renderBoothGroups' own comment for the
          // real bug this fixes). Computed per child, independent of this
          // category's own hasBoothGroups.
          const childViews = children
            .map((child) => {
              const childBoothGroups = boothGroupsForCategory(child.name);
              const items = childBoothGroups.length > 0 ? child.items.filter((li) => !li.boothLabel) : child.items;
              return { name: child.name, items, boothGroups: childBoothGroups };
            })
            .filter((child) => child.items.length > 0 || child.boothGroups.length > 0);
          if (flatOwnItems.length === 0 && childViews.length === 0 && !hasBoothGroups) return null;

          const boothTotal = boothGroups.reduce((sum, b) => sum + b.subtotal, 0);
          const childBoothTotal = childViews.reduce(
            (sum, c) => sum + c.boothGroups.reduce((s, b) => s + b.subtotal, 0),
            0,
          );
          const flatTotal = bucketSubtotal(flatOwnItems) + childViews.reduce((sum, c) => sum + bucketSubtotal(c.items), 0);
          const sectionTotal = boothTotal + childBoothTotal + flatTotal;
          // The header's own PRICE can't just gross up sectionTotal (the
          // combined raw COST) by this top-level category's own margin --
          // confirmed live as a real bug: a Method-split child category
          // (e.g. "Structure - Rental") can carry its own margin override
          // that differs from its parent's, and grossing the parent's
          // combined cost up by the PARENT's margin alone silently
          // discarded that override, showing a header total that didn't
          // match the sum of the child rows underneath it (a $1,000 cost
          // child correctly priced at $2,000 under its own 50% override
          // rendered as $1,666.67 in the parent header above it, using
          // the parent's 40% target instead). Each contributor is grossed
          // up by its OWN resolved category here -- the top-level's own
          // booths/flat items by categoryName (unchanged), each child's
          // own booths/flat items by that child's own name -- then
          // summed, the same way Cost already does above.
          const sellSectionTotal =
            sellForCategory(boothTotal + bucketSubtotal(flatOwnItems), categoryName) +
            childViews.reduce((sum, c) => {
              const childRawTotal = bucketSubtotal(c.items) + c.boothGroups.reduce((s, b) => s + b.subtotal, 0);
              return sum + sellForCategory(childRawTotal, c.name);
            }, 0);

          return (
            <View key={categoryName} style={styles.section}>
              {/* wrap={false} on the header + its summary together, not
                  minPresenceAhead on the header alone -- see renderBoothGroups'
                  own comment on this same fix above. */}
              <View wrap={false}>
                <View style={styles.sectionHeaderRow}>
                  <View style={styles.sectionHeaderLeft}>
                    <View style={[styles.sectionAccentSwatch, { backgroundColor: accent }]} />
                    <Text style={styles.sectionHeaderText}>{categoryName}</Text>
                  </View>
                  <Text style={styles.sectionHeaderTotal}>
                    {hidePrice ? "" : amountContent(sectionTotal, sellSectionTotal, data.showCost)}
                  </Text>
                </View>
                {/* Top tier of the three-level Proposal PDF copy system --
                    see EstimateCategorySummary's own schema comment. Always
                    shown when written, spanning every booth in this
                    category, independent of any booth's own
                    summarizeOnProposal/detail state below. */}
                {data.categorySummaries?.get(categoryName) && (
                  <Text style={styles.proposalSummaryText}>
                    {truncateProposalSummary(data.categorySummaries.get(categoryName)!)}
                  </Text>
                )}
              </View>
              {categoryName === "Professional Services" &&
                data.professionalServices &&
                data.professionalServices.items.length > 0 && (
                  <View style={styles.professionalServicesRow}>
                    <View style={styles.professionalServicesList}>
                      {data.professionalServices.items.map((item, i) => (
                        <Text key={i} style={styles.professionalServicesItem}>
                          • {item}
                        </Text>
                      ))}
                    </View>
                  </View>
                )}
              {hasBoothGroups && renderBoothGroups(boothGroups, categoryName, hidePrice, isSummary, isServiceStyle)}
              {isSummary
                ? renderSummaryBody(flatOwnItems)
                : isServiceStyle
                  ? renderServiceBody(flatOwnItems, categoryName, hidePrice)
                  : renderBody(flatOwnItems, categoryName, hidePrice)}
              {childViews.map((child) => {
                const childTotal = bucketSubtotal(child.items) + child.boothGroups.reduce((s, b) => s + b.subtotal, 0);
                return (
                  <View key={child.name} style={styles.subsection}>
                    <View style={styles.subsectionHeaderRow} minPresenceAhead={24}>
                      <Text style={styles.subsectionHeaderText}>{child.name}</Text>
                      <Text style={styles.subsectionHeaderTotal}>
                        {hidePrice ? "" : amountContent(childTotal, sellForCategory(childTotal, child.name), data.showCost)}
                      </Text>
                    </View>
                    {child.boothGroups.length > 0 &&
                      renderBoothGroups(child.boothGroups, child.name, hidePrice, isSummary, isServiceStyle)}
                    {isSummary ? renderSummaryBody(child.items) : renderBody(child.items, child.name, hidePrice)}
                  </View>
                );
              })}
            </View>
          );
        })}

        {documentGrandTotal > 0 && (
          <View style={styles.subtotalsBlock}>
            {hasServiceSplit && (
              <>
                <View style={styles.subtotalsRow}>
                  <Text style={styles.subtotalsRowLabel}>Rental components total</Text>
                  <Text style={styles.subtotalsRowValue}>
                    {amountContent(rentalTotal, sellRentalTotal, data.showCost)}
                  </Text>
                </View>
                <View style={styles.subtotalsRow}>
                  <Text style={styles.subtotalsRowLabel}>Show services total</Text>
                  <Text style={styles.subtotalsRowValue}>
                    {amountContent(servicesTotal, sellServicesTotal, data.showCost)}
                  </Text>
                </View>
              </>
            )}
            {/* Not a computed tax amount -- Labor/Shipping are excluded
                from sales tax in this business's actual practice, so the
                taxable base is exactly the rental components total
                (already computed above). No tax rate or jurisdiction
                logic involved; this just labels which part of the total
                is subject to tax at all. Uses sellRentalTotal, not
                rentalTotal -- tax applies to what the client is actually
                charged, not internal cost (this was a real, separate
                latent bug: the base was cost even on the client-facing
                document before this fix). */}
            <View style={styles.subtotalsRow}>
              <Text style={styles.subtotalsRowLabel}>Total taxable</Text>
              <Text style={styles.subtotalsRowValue}>
                {amountContent(rentalTotal, sellRentalTotal, data.showCost)}
              </Text>
            </View>
            {data.taxRate && (
              <>
                <View style={styles.subtotalsRow}>
                  <Text style={styles.subtotalsRowLabel}>
                    Estimated tax ({data.taxRate.label}, {(data.taxRate.rate * 100).toFixed(2)}%)
                  </Text>
                  <Text style={styles.subtotalsRowValue}>
                    {moneyFromNumber(sellRentalTotal * data.taxRate.rate)}
                  </Text>
                </View>
                <Text style={styles.taxDisclaimer}>{TAX_ESTIMATE_DISCLAIMER}</Text>
              </>
            )}
          </View>
        )}

        {data.paymentMethodNote && (
          <View style={styles.paymentMethodNote}>
            <Text style={styles.paymentMethodLabel}>Payment Method</Text>
            <Text style={styles.paymentMethodText}>{data.paymentMethodNote}</Text>
          </View>
        )}

        <View style={styles.totalRow}>
          {data.showCost && (
            <View style={[styles.totalBlock, styles.totalCostBlock]}>
              <Text style={styles.totalLabel}>Total cost</Text>
              <Text style={styles.totalCostValue}>{moneyFromNumber(totalCostSum)}</Text>
            </View>
          )}
          <View style={styles.totalBlock}>
            <Text style={styles.totalLabel}>Grand total</Text>
            <Text style={styles.totalValue}>{moneyFromNumber(documentGrandTotal)}</Text>
          </View>
        </View>

        {data.termsAndConditions.length > 0 && (
          <View break style={styles.termsSection}>
            <Text style={styles.termsHeading}>Terms &amp; Conditions</Text>
            {data.termsAndConditions.map((clause, i) => (
              <Text key={i} style={styles.termsClause}>
                <Text style={styles.termsClauseNumber}>{i + 1}. </Text>
                {clause}
              </Text>
            ))}
            <View style={styles.signatureSection} wrap={false}>
              <View style={styles.signatureBlock}>
                <View style={styles.signatureLine} />
                <Text style={styles.signatureLabel}>Client — signature, name, date</Text>
              </View>
              <View style={styles.signatureBlock}>
                <View style={styles.signatureLine} />
                <Text style={styles.signatureLabel}>{BRAND_COMPANY_NAME} — signature, name, date</Text>
              </View>
            </View>
          </View>
        )}

        <View style={styles.footer} fixed>
          <Text>
            {data.signedAt
              ? `Signed by ${data.signedByName ?? "unknown"}${data.signedByTitle ? `, ${data.signedByTitle}` : ""} — ${formatDate(data.signedAt)}`
              : data.sentAt
                ? `Sent ${formatDate(data.sentAt)}`
                : "Draft — not yet sent"}
          </Text>
          <View style={styles.footerBottomRow}>
            <Text>{BRAND_COMPANY_NAME} — {BRAND_TAGLINE} — Powered by ForgeOS</Text>
            <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
          </View>
        </View>
      </Page>
    </Document>
  );
}
