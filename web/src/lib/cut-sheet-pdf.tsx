// Cut-list phase 3: renders a material's stored cutting layouts
// (cut-list-nesting-service.ts's CutSheetDiagramData) as a real printable
// diagram -- one page per sheet, drawn to scale. Reuses @react-pdf/renderer,
// the same library proposal-pdf.tsx already uses for the proposal PDF,
// but its SVG primitives (Svg/Rect/Text-with-x-y) instead of the plain
// document layout that file uses -- confirmed these are real, typed,
// exported components before building this, not assumed from docs.
//
// Rendered on demand at request time, not pre-generated and stored --
// same posture as the existing proposal PDF route
// (app/(app)/proposals/[id]/pdf/route.ts calls renderToBuffer directly
// against fresh data on every request). A stored file would need its own
// staleness/invalidation story the moment a cut list gets re-optimized;
// re-rendering from the current CutSheet rows every time sidesteps that
// entirely, at the cost of a cheap re-render per download -- worth it,
// this isn't an expensive AI call.
//
// The SVG's viewBox uses the sheet's own real inch dimensions directly
// (viewBox="0 0 stockWidth stockLength") -- every coordinate inside it
// (rect x/y/width/height, text fontSize) is in real inches, not PDF
// points, and the <Svg> element's own width/height (computed to fit the
// page while preserving the sheet's true aspect ratio) is what maps that
// inch-space onto the printed page. Getting fontSize wrong here is an
// easy mistake (a size that reads fine in normal document text is
// enormous at this scale) -- kept as a small fraction of the sheet's
// shorter dimension so it scales sensibly across a 24" and a 96" sheet.

import { Document, Page, View, Text, Svg, Rect, G, StyleSheet } from "@react-pdf/renderer";
import { BRAND } from "@/lib/brand";
import type { CutSheetDiagramData } from "@/lib/cut-list-nesting-service";

const styles = StyleSheet.create({
  page: { padding: 32, fontFamily: "Helvetica", fontSize: 9, color: BRAND.black },
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    marginBottom: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e5e5",
  },
  materialName: { fontSize: 14, fontWeight: 700, color: BRAND.navy },
  sheetLabel: { fontSize: 9, color: "#737373", marginTop: 2 },
  remnantLabel: { fontSize: 8, fontWeight: 700, color: BRAND.tangerine, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 2 },
  stockLabel: { fontSize: 9, textAlign: "right" },
  diagramWrap: { alignItems: "center", marginBottom: 16 },
  legendTitle: { fontSize: 8, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, color: "#737373", marginBottom: 4 },
  legendRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#eee", paddingVertical: 3 },
  legendNum: { width: 24, fontWeight: 700 },
  legendDesc: { flex: 1 },
  legendDims: { width: 90, textAlign: "right" },
});

// Max box the diagram itself is allowed to occupy on the page (points) --
// a fixed printable area, independent of the sheet's real size; the SVG's
// own width/height (below) are scaled DOWN from this to fit whichever of
// the sheet's two dimensions is the constraining one, so a 24"x24" sheet
// and a 48"x96" sheet both fill this box sensibly instead of one being
// tiny and the other overflowing it.
const DIAGRAM_MAX_WIDTH = 500;
const DIAGRAM_MAX_HEIGHT = 380;

export function CutSheetDiagramDocument({ data }: { data: CutSheetDiagramData }) {
  const { materialName, sheets } = data;

  return (
    <Document>
      {sheets.map((sheet) => {
        // Each sheet draws against ITS OWN real usable area -- a
        // remnant's own (smaller) dimensions, not the material's
        // nominal stock size (data.stockWidth/stockLength), or the
        // diagram would show a shop-floor cutter the wrong sheet size.
        const scale = Math.min(DIAGRAM_MAX_WIDTH / sheet.width, DIAGRAM_MAX_HEIGHT / sheet.length);
        const svgWidth = sheet.width * scale;
        const svgHeight = sheet.length * scale;
        // A small fraction of the sheet's shorter real dimension -- see
        // file header. Inline labels only render for a part with room
        // to plausibly hold them; every part is always listed in the
        // legend table below regardless, so nothing depends on the
        // label actually fitting.
        const labelFontSize = Math.max(Math.min(sheet.width, sheet.length) * 0.018, 0.15);

        return (
      <Page key={sheet.sheetNumber} size="LETTER" orientation="landscape" style={styles.page}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.materialName}>{materialName}</Text>
              <Text style={styles.sheetLabel}>
                Sheet {sheet.sheetNumber} of {sheets.length}
              </Text>
              {sheet.isRemnant && <Text style={styles.remnantLabel}>Remnant -- already-owned offcut, not a fresh sheet</Text>}
            </View>
            <Text style={styles.stockLabel}>
              Stock: {sheet.width}&quot; x {sheet.length}&quot;
            </Text>
          </View>

          <View style={styles.diagramWrap}>
            <Svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${sheet.width} ${sheet.length}`}>
              <Rect x={0} y={0} width={sheet.width} height={sheet.length} fill="#ffffff" stroke={BRAND.black} strokeWidth={0.05} />
              {sheet.parts.map((part, i) => {
                const canLabel = part.width > labelFontSize * 5 && part.height > labelFontSize * 2.5;
                return (
                  <G key={part.cutListPartId + i}>
                    <Rect
                      x={part.x}
                      y={part.y}
                      width={part.width}
                      height={part.height}
                      fill={BRAND.tealPale}
                      stroke={BRAND.teal}
                      strokeWidth={0.03}
                    />
                    <Text x={part.x + labelFontSize * 0.3} y={part.y + labelFontSize * 1.1} style={{ fontSize: labelFontSize }}>
                      {i + 1}
                    </Text>
                    {canLabel && (
                      <Text
                        x={part.x + labelFontSize * 0.3}
                        y={part.y + labelFontSize * 2.3}
                        style={{ fontSize: labelFontSize * 0.7 }}
                      >
                        {`${part.width.toFixed(1)}x${part.height.toFixed(1)}${part.rotated ? " (rot)" : ""}`}
                      </Text>
                    )}
                  </G>
                );
              })}
            </Svg>
          </View>

          <Text style={styles.legendTitle}>Parts on this sheet</Text>
          {sheet.parts.map((part, i) => (
            <View key={part.cutListPartId + i} style={styles.legendRow} wrap={false}>
              <Text style={styles.legendNum}>{i + 1}</Text>
              <Text style={styles.legendDesc}>
                {part.description}
                {part.rotated ? " (rotated)" : ""}
              </Text>
              <Text style={styles.legendDims}>
                {part.width.toFixed(2)}&quot; x {part.height.toFixed(2)}&quot;
              </Text>
            </View>
          ))}
      </Page>
        );
      })}
    </Document>
  );
}
