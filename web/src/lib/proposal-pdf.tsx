// B2: a real downloadable PDF, not just the live web page -- sales needs
// something attachable to an email, matching what the old workbook's
// PROPOSAL sheet always produced. @react-pdf/renderer is pure JS (no
// headless-browser/Chromium binary), so it doesn't touch the Docker
// image's footprint the way Puppeteer would have.

import path from "node:path";
import { Document, Page, Text, View, Image as PdfImage, StyleSheet, Font } from "@react-pdf/renderer";
import type { Prisma } from "@/generated/prisma/client";
import { BRAND, BRAND_ADDRESS_LINES, BRAND_COMPANY_NAME, BRAND_TAGLINE } from "@/lib/brand";

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
  page: { padding: 48, fontSize: 10, fontFamily: "Helvetica", color: BRAND.black },
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
    backgroundColor: BRAND.black,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  sectionAccentSwatch: { width: 7, height: 7, marginRight: 6 },
  sectionHeaderText: {
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.75,
    color: BRAND.white,
  },
  // A booth/exhibit group's main heading -- one level up from a plain
  // section header (slightly larger, shows a running total for
  // everything inside it), with its sub-sections (Booth Build, Platform,
  // etc.) nested underneath via categoryHeaderRow.
  boothHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: BRAND.black,
    paddingVertical: 7,
    paddingHorizontal: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  boothHeaderLeft: { flexDirection: "row", alignItems: "center" },
  boothHeaderText: { fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.75, color: BRAND.white },
  boothHeaderTotal: { fontSize: 9.5, fontWeight: 700, color: BRAND.white },
  boothBody: { marginLeft: 10 },
  categoryHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#efefef",
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginBottom: 2,
  },
  categoryHeaderText: {
    fontSize: 7.5,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: BRAND.black,
  },
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
  summaryRow: {
    flexDirection: "row",
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  summaryDescription: { width: "48%", color: "#737373" },
  subtotalRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    paddingTop: 4,
    paddingHorizontal: 6,
  },
  colDescription: { width: "48%" },
  colQty: { width: "14%", textAlign: "right" },
  colUnit: { width: "13%", textAlign: "right" },
  colTotal: { width: "25%", textAlign: "right" },
  headerCell: { color: BRAND.black, fontSize: 8, textTransform: "uppercase", fontWeight: 700 },
  subtotalLabel: { width: "75%", textAlign: "right", fontSize: 9, fontWeight: 700, color: BRAND.navy },
  subtotalValue: { width: "25%", textAlign: "right", fontSize: 9, fontWeight: 700, color: BRAND.navy },
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
  footer: {
    position: "absolute",
    bottom: 32,
    left: 48,
    right: 48,
    fontSize: 8,
    color: "#a3a3a3",
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    paddingTop: 8,
  },
});

function money(d: Prisma.Decimal): string {
  return `$${d.toFixed(2)}`;
}

function moneyFromNumber(n: number): string {
  return `$${n.toFixed(2)}`;
}

function formatQty(d: Prisma.Decimal): string {
  const n = d.toNumber();
  return Number.isInteger(n) ? n.toString() : n.toFixed(2);
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface ProposalPdfLineItem {
  id: string;
  description: string;
  qty: Prisma.Decimal;
  unit: string | null;
  totalCost: Prisma.Decimal;
}

export interface ProposalPdfSection {
  name: string;
  // Non-null when this section is one sub-element (Booth Build, Platform,
  // etc.) of a booth/exhibit instance -- see pricing-import-service.ts.
  // Sections sharing the same groupLabel render nested under one shared
  // booth heading instead of as separate top-level sections.
  groupLabel: string | null;
  lineItems: ProposalPdfLineItem[];
}

// Detail level controls the itemized-vs-rolled-up tradeoff: "summary"
// (the default) shows just each section's item count and subtotal --
// "full" itemizes every line, document-wide. detailSectionNames lets
// specific booths or categories opt into full detail even when the
// document-wide mode is summary (matched against either a booth's
// groupLabel or a plain/category section's own name).
export type ProposalDetailMode = "summary" | "full";

export interface ProposalPdfData {
  companyName: string;
  showName: string;
  templateName: string;
  brandColor: string | null;
  proposalDate: Date;
  sections: ProposalPdfSection[];
  grandTotal: Prisma.Decimal;
  sentAt: Date | null;
  signedAt: Date | null;
  signedByName: string | null;
  signedByTitle: string | null;
  detailMode: ProposalDetailMode;
  detailSectionNames: string[];
}

type RenderBlock =
  | { kind: "booth"; label: string; sections: ProposalPdfSection[] }
  | { kind: "standalone"; section: ProposalPdfSection };

// Groups the flat section list into booth blocks (consecutive-or-not
// sections sharing a groupLabel, collected under their first occurrence)
// plus standalone blocks for sections with no groupLabel -- preserves
// each block's original relative order.
function buildRenderBlocks(sections: ProposalPdfSection[]): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const boothBlockIndex = new Map<string, number>();
  for (const section of sections) {
    if (section.groupLabel) {
      let index = boothBlockIndex.get(section.groupLabel);
      if (index === undefined) {
        index = blocks.length;
        boothBlockIndex.set(section.groupLabel, index);
        blocks.push({ kind: "booth", label: section.groupLabel, sections: [] });
      }
      (blocks[index] as { kind: "booth"; label: string; sections: ProposalPdfSection[] }).sections.push(section);
    } else {
      blocks.push({ kind: "standalone", section });
    }
  }
  return blocks;
}

function sectionSubtotal(section: ProposalPdfSection): number {
  return section.lineItems.reduce((sum, li) => sum + li.totalCost.toNumber(), 0);
}

export function ProposalPdfDocument({ data }: { data: ProposalPdfData }) {
  const sections = data.sections.filter((s) => s.lineItems.length > 0);
  const blocks = buildRenderBlocks(sections);
  const isDetailed = (section: ProposalPdfSection) =>
    data.detailMode === "full" ||
    (section.groupLabel !== null && data.detailSectionNames.includes(section.groupLabel)) ||
    data.detailSectionNames.includes(section.name);

  const renderBody = (section: ProposalPdfSection) =>
    isDetailed(section) ? (
      <>
        {section.lineItems.map((li) => (
          <View key={li.id} style={styles.tableRow} wrap={false}>
            <Text style={styles.colDescription}>{li.description}</Text>
            <Text style={styles.colQty}>{formatQty(li.qty)}</Text>
            <Text style={styles.colUnit}>{li.unit ?? ""}</Text>
            <Text style={styles.colTotal}>{money(li.totalCost)}</Text>
          </View>
        ))}
        <View style={styles.subtotalRow}>
          <Text style={styles.subtotalLabel}>{section.name} total</Text>
          <Text style={styles.subtotalValue}>{moneyFromNumber(sectionSubtotal(section))}</Text>
        </View>
      </>
    ) : (
      <View style={styles.summaryRow}>
        <Text style={styles.summaryDescription}>
          {section.lineItems.length} item{section.lineItems.length === 1 ? "" : "s"}
        </Text>
        <Text style={styles.colQty} />
        <Text style={styles.colUnit} />
        <Text style={[styles.colTotal, { fontWeight: 700, color: BRAND.navy }]}>
          {moneyFromNumber(sectionSubtotal(section))}
        </Text>
      </View>
    );

  return (
    <Document title={`Proposal — ${data.showName}`}>
      <Page size="LETTER" style={styles.page}>
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
            <Text style={styles.company}>Prepared for {data.companyName}</Text>
            <Text style={styles.showName}>{data.showName}</Text>
          </View>
          <View>
            <Text style={styles.templateLabel}>Proposal date</Text>
            <Text style={styles.templateName}>{formatDate(data.proposalDate)}</Text>
          </View>
        </View>

        <View style={styles.tableHeaderRow}>
          <Text style={[styles.colDescription, styles.headerCell]}>Description</Text>
          <Text style={[styles.colQty, styles.headerCell]}>Qty</Text>
          <Text style={[styles.colUnit, styles.headerCell]}>Unit</Text>
          <Text style={[styles.colTotal, styles.headerCell]}>Total</Text>
        </View>

        {blocks.map((block, blockIndex) => {
          const accent = SECTION_ACCENTS[blockIndex % SECTION_ACCENTS.length];
          if (block.kind === "standalone") {
            const section = block.section;
            return (
              <View key={`section-${blockIndex}`} style={styles.section}>
                <View style={styles.sectionHeaderRow} minPresenceAhead={24}>
                  <View style={[styles.sectionAccentSwatch, { backgroundColor: accent }]} />
                  <Text style={styles.sectionHeaderText}>{section.name}</Text>
                </View>
                {renderBody(section)}
              </View>
            );
          }
          const boothTotal = block.sections.reduce((sum, s) => sum + sectionSubtotal(s), 0);
          return (
            <View key={`booth-${blockIndex}`} style={styles.section}>
              <View style={styles.boothHeaderRow} minPresenceAhead={24}>
                <View style={styles.boothHeaderLeft}>
                  <View style={[styles.sectionAccentSwatch, { backgroundColor: accent }]} />
                  <Text style={styles.boothHeaderText}>{block.label}</Text>
                </View>
                <Text style={styles.boothHeaderTotal}>{moneyFromNumber(boothTotal)}</Text>
              </View>
              <View style={styles.boothBody}>
                {block.sections.map((section, sectionIndex) => (
                  <View key={`${section.name}-${sectionIndex}`} style={styles.section}>
                    <View style={styles.categoryHeaderRow} minPresenceAhead={24}>
                      <Text style={styles.categoryHeaderText}>{section.name}</Text>
                    </View>
                    {renderBody(section)}
                  </View>
                ))}
              </View>
            </View>
          );
        })}

        <View style={styles.totalRow}>
          <View style={styles.totalBlock}>
            <Text style={styles.totalLabel}>Grand total</Text>
            <Text style={styles.totalValue}>{money(data.grandTotal)}</Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text>
            {data.signedAt
              ? `Signed by ${data.signedByName ?? "unknown"}${data.signedByTitle ? `, ${data.signedByTitle}` : ""} — ${formatDate(data.signedAt)}`
              : data.sentAt
                ? `Sent ${formatDate(data.sentAt)}`
                : "Draft — not yet sent"}
          </Text>
          <Text style={{ marginTop: 2 }}>{BRAND_COMPANY_NAME} — {BRAND_TAGLINE}</Text>
          <Text style={{ marginTop: 2 }}>Powered by ForgeOS</Text>
        </View>
      </Page>
    </Document>
  );
}


