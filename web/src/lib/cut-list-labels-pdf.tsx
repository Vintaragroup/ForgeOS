// Cut-list phase 9: one printable label per physical cut piece -- meant
// to be printed, cut apart, and stuck on each part after cutting so a
// piece can be identified on the shop floor without walking back to a
// screen. Same @react-pdf/renderer pattern cut-sheet-pdf.tsx already
// established (StyleSheet.create, renderToBuffer via a GET route),
// rendered fresh from the current CutSheet rows on every request -- same
// no-caching posture as every other cut-list PDF/DXF download.
//
// Text-only, no barcode/QR: there's no defined "scan this to do X"
// workflow yet in this app to justify the new dependency and design
// surface a barcode would need -- easy to add later once one exists.
//
// The label grid below (3 columns x 8 rows, ~2.5"x1.25" each) is a
// generic approximate layout, NOT tuned to a specific commercial
// adhesive-label product (e.g. an Avery SKU) -- that needs real paper
// testing to dial in exact margins, which isn't verifiable here.
import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import { BRAND } from "@/lib/brand";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";

export interface CutListLabelData {
  showName: string;
  materialName: string;
  sheetNumber: number;
  partNumber: number;
  description: string;
  width: number;
  height: number;
  rotated: boolean;
  grainConstrained: boolean;
}

const LABEL_COLS = 3;
const LABEL_ROWS = 8;
const LABELS_PER_PAGE = LABEL_COLS * LABEL_ROWS;
const PAGE_MARGIN = 24;

const styles = StyleSheet.create({
  page: { padding: PAGE_MARGIN, fontFamily: "Helvetica", color: BRAND.black },
  grid: { flexDirection: "row", flexWrap: "wrap" },
  label: {
    width: `${100 / LABEL_COLS}%`,
    height: 468 / LABEL_ROWS, // ~9.75in usable height at 72pt/in, split across LABEL_ROWS
    padding: 8,
    borderWidth: 0.5,
    borderColor: "#d4d4d4",
    borderStyle: "dashed",
    justifyContent: "space-between",
  },
  showName: { fontSize: 6, color: "#737373", textTransform: "uppercase", letterSpacing: 0.5 },
  materialName: { fontSize: 7, color: "#737373" },
  description: { fontSize: 9, fontWeight: 700, color: BRAND.navy, marginTop: 2 },
  dims: { fontSize: 9, marginTop: 2 },
  footerRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
  locator: { fontSize: 7, color: "#737373" },
  grainFlag: { fontSize: 7, color: "#b45309", fontWeight: 700 },
});

// Pure, testable independent of rendering -- same split cut-sheet-pdf.tsx
// itself doesn't need (it's driven straight from CutSheetDiagramData) but
// which the extra grainConstrained join here makes worth pulling out on
// its own.
export function buildCutListLabels(
  showName: string,
  data: CutSheetDiagramData,
  grainConstrainedByPartId: Map<string, boolean>,
): CutListLabelData[] {
  const labels: CutListLabelData[] = [];
  for (const sheet of data.sheets) {
    sheet.parts.forEach((part, i) => {
      labels.push({
        showName,
        materialName: data.materialName,
        sheetNumber: sheet.sheetNumber,
        // Same 1-based per-sheet numbering the diagram PDF's own legend
        // uses (cut-sheet-pdf.tsx's `{i + 1}`) -- lets a shop worker
        // match a label back to the printed diagram.
        partNumber: i + 1,
        description: part.description,
        width: part.width,
        height: part.height,
        rotated: part.rotated,
        grainConstrained: grainConstrainedByPartId.get(part.cutListPartId) ?? false,
      });
    });
  }
  return labels;
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

export function CutListLabelsDocument({ labels }: { labels: CutListLabelData[] }) {
  const pages = chunk(labels, LABELS_PER_PAGE);

  return (
    <Document>
      {pages.map((pageLabels, pageIndex) => (
        <Page key={pageIndex} size="LETTER" style={styles.page}>
          <View style={styles.grid}>
            {pageLabels.map((label, i) => (
              <View key={i} style={styles.label} wrap={false}>
                <View>
                  <Text style={styles.showName}>{label.showName}</Text>
                  <Text style={styles.materialName}>{label.materialName}</Text>
                  <Text style={styles.description}>{label.description}</Text>
                  <Text style={styles.dims}>
                    {label.width.toFixed(2)}&quot; x {label.height.toFixed(2)}&quot;
                    {label.rotated ? " (rotated)" : ""}
                  </Text>
                </View>
                <View style={styles.footerRow}>
                  <Text style={styles.locator}>
                    Sheet {label.sheetNumber} · Part {label.partNumber}
                  </Text>
                  {label.grainConstrained && <Text style={styles.grainFlag}>GRAIN</Text>}
                </View>
              </View>
            ))}
          </View>
        </Page>
      ))}
    </Document>
  );
}
