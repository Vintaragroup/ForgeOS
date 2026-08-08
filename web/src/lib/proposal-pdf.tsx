// B2: a real downloadable PDF, not just the live web page -- sales needs
// something attachable to an email, matching what the old workbook's
// PROPOSAL sheet always produced. @react-pdf/renderer is pure JS (no
// headless-browser/Chromium binary), so it doesn't touch the Docker
// image's footprint the way Puppeteer would have.

import path from "node:path";
import { Document, Page, Text, View, Image as PdfImage, StyleSheet, Font } from "@react-pdf/renderer";
import type { Prisma } from "@/generated/prisma/client";
import { BRAND, BRAND_COMPANY_NAME, BRAND_TAGLINE } from "@/lib/brand";

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
const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, fontFamily: "Helvetica", color: BRAND.black },
  accentBar: { height: 6, marginBottom: 20 },
  issuerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 },
  issuerLogo: { height: 20, width: 59 },
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
  table: { marginBottom: 24 },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1.5,
    borderBottomColor: BRAND.black,
    paddingBottom: 4,
    marginBottom: 4,
  },
  tableRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: "#f5f5f5",
    paddingVertical: 4,
  },
  colSection: { width: "25%", color: "#737373" },
  colDescription: { width: "55%" },
  colTotal: { width: "20%", textAlign: "right" },
  headerCell: { color: BRAND.black, fontSize: 8, textTransform: "uppercase", fontWeight: 700 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    paddingTop: 12,
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

export interface ProposalPdfData {
  companyName: string;
  showName: string;
  templateName: string;
  brandColor: string | null;
  sections: { name: string; lineItems: { id: string; description: string; totalCost: Prisma.Decimal }[] }[];
  grandTotal: Prisma.Decimal;
  sentAt: Date | null;
  signedAt: Date | null;
  signedByName: string | null;
  signedByTitle: string | null;
}

export function ProposalPdfDocument({ data }: { data: ProposalPdfData }) {
  const rows = data.sections.flatMap((section) =>
    section.lineItems.map((li) => ({ section: section.name, ...li })),
  );

  return (
    <Document title={`Proposal — ${data.showName}`}>
      <Page size="LETTER" style={styles.page}>
        <View style={[styles.accentBar, { backgroundColor: data.brandColor ?? BRAND.navy }]} />
        <View style={styles.issuerRow}>
          <PdfImage src={LOGO_PATH} style={styles.issuerLogo} />
          <Text style={styles.docType}>Proposal</Text>
        </View>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.company}>Prepared for {data.companyName}</Text>
            <Text style={styles.showName}>{data.showName}</Text>
          </View>
          <View>
            <Text style={styles.templateLabel}>Template</Text>
            <Text style={styles.templateName}>{data.templateName}</Text>
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeaderRow}>
            <Text style={[styles.colSection, styles.headerCell]}>Section</Text>
            <Text style={[styles.colDescription, styles.headerCell]}>Description</Text>
            <Text style={[styles.colTotal, styles.headerCell]}>Total</Text>
          </View>
          {rows.map((row) => (
            <View key={row.id} style={styles.tableRow}>
              <Text style={styles.colSection}>{row.section}</Text>
              <Text style={styles.colDescription}>{row.description}</Text>
              <Text style={styles.colTotal}>{money(row.totalCost)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totalRow}>
          <View style={styles.totalBlock}>
            <Text style={styles.totalLabel}>Grand total</Text>
            <Text style={styles.totalValue}>{money(data.grandTotal)}</Text>
          </View>
        </View>

        <View style={styles.footer}>
          <Text>
            {data.signedAt
              ? `Signed by ${data.signedByName ?? "unknown"}${data.signedByTitle ? `, ${data.signedByTitle}` : ""} — ${data.signedAt.toISOString().slice(0, 10)}`
              : data.sentAt
                ? `Sent ${data.sentAt.toISOString().slice(0, 10)}`
                : "Draft — not yet sent"}
          </Text>
          <Text style={{ marginTop: 2 }}>{BRAND_COMPANY_NAME} — {BRAND_TAGLINE}</Text>
          <Text style={{ marginTop: 2 }}>Powered by ForgeOS</Text>
        </View>
      </Page>
    </Document>
  );
}
