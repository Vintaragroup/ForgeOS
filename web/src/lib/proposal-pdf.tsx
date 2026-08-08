// B2: a real downloadable PDF, not just the live web page -- sales needs
// something attachable to an email, matching what the old workbook's
// PROPOSAL sheet always produced. @react-pdf/renderer is pure JS (no
// headless-browser/Chromium binary), so it doesn't touch the Docker
// image's footprint the way Puppeteer would have.

import { Document, Page, Text, View, StyleSheet, Font } from "@react-pdf/renderer";
import type { Prisma } from "@/generated/prisma/client";

Font.registerHyphenationCallback((word) => [word]);

const styles = StyleSheet.create({
  page: { padding: 48, fontSize: 10, fontFamily: "Helvetica", color: "#171717" },
  accentBar: { height: 4, marginBottom: 24 },
  headerRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 24 },
  company: { fontSize: 9, color: "#737373" },
  showName: { fontSize: 16, fontWeight: 700, marginTop: 2 },
  templateLabel: { fontSize: 8, color: "#737373", textAlign: "right" },
  templateName: { fontSize: 10, fontWeight: 700, textAlign: "right", marginTop: 2 },
  table: { marginBottom: 24 },
  tableHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
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
  headerCell: { color: "#737373", fontSize: 8, textTransform: "uppercase" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    borderTopWidth: 1,
    borderTopColor: "#e5e5e5",
    paddingTop: 12,
  },
  totalBlock: { alignItems: "flex-end" },
  totalLabel: { fontSize: 8, color: "#737373" },
  totalValue: { fontSize: 18, fontWeight: 700, marginTop: 2 },
  footer: { position: "absolute", bottom: 32, left: 48, right: 48, fontSize: 8, color: "#a3a3a3" },
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
        <View style={[styles.accentBar, { backgroundColor: data.brandColor ?? "#171717" }]} />
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.company}>{data.companyName}</Text>
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
        </View>
      </Page>
    </Document>
  );
}
