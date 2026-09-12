// Artwork pipeline, proof-sheet piece: a print-shop-style proof document
// for ONE ArtworkOrder, modeled directly on a real vendor proof sheet
// (data/Proof-Artwork/Proof_SO399945-*.pdf) but re-skinned in ExpoCCI's
// own brand -- so Expo reviews artwork in the layout their industry
// already expects, not a generic file-view page. Same @react-pdf/renderer
// pattern every other PDF in this app uses (task-packet-pdf.tsx,
// proposal-pdf.tsx): a pure, testable data-builder plus a presentational
// Document component, rendered via renderToBuffer in a GET route.
//
// Deliberately does NOT invent fields the reference sheet has but ForgeOS
// doesn't track: no barcode (no barcode data source exists), no S/F /
// D/F:S / D/F:D / ply checkboxes (no matching ArtworkOrder field). Only
// real data gets rendered -- an honest, shorter sheet rather than a
// fabricated one.
import path from "node:path";
import { Document, Page, Text, View, Svg, Line, Polygon, Rect, Image as PdfImage, StyleSheet } from "@react-pdf/renderer";
import { BRAND, BRAND_COMPANY_NAME } from "@/lib/brand";

const LOGO_PATH = path.join(process.cwd(), "public", "brand", "expo-logo-white.png");

export interface ArtworkProofData {
  jobCode: string;
  companyName: string;
  projectName: string;
  date: string;
  revision: number;
  description: string;
  fileName: string;
  material: string;
  qty: number;
  sizeLabel: string;
  widthIn: number | null;
  heightIn: number | null;
  bleedIn: number | null;
  // Set only when a requested size (production spec or size tier) AND a
  // file-measured size both exist and disagree beyond SIZE_MISMATCH_TOLERANCE_IN
  // -- real QC value (this is what's about to print vs. what was ordered),
  // never fabricated when either side of the comparison is unknown.
  sizeMismatchWarning: string | null;
  preparedBy: string;
  artworkImageDataUrl: string | null;
  previewUnavailable: boolean;
}

// How far apart a requested size and the file-measured size can be before
// it's worth flagging -- loose enough to absorb a PDF page's own rounding/
// margin noise, tight enough to still catch a genuine wrong-file mistake.
const SIZE_MISMATCH_TOLERANCE_IN = 0.25;

// Plain, explicit arguments rather than a raw Prisma payload -- the route
// does its own DB shaping, this stays trivial to unit test. Mirrors
// buildTaskPacketData's own split.
export function buildArtworkProofData(input: {
  jobCode: string;
  companyName: string;
  showName: string;
  boothNumber: string | null;
  date: Date;
  revisionRound: number;
  material: string | null;
  qty: number;
  fileName: string | null;
  sizeTierLabel: string | null;
  sizeTierWidth: number | null;
  sizeTierHeight: number | null;
  customWidth: number | null;
  customHeight: number | null;
  bleedIn: number | null;
  // The file's own real page size, read straight off the uploaded PDF
  // (getPdfPageDimensionsInInches) -- when present, this is what's about
  // to print, so it takes priority over anything typed in.
  measuredWidthIn: number | null;
  measuredHeightIn: number | null;
  ownerName: string | null;
  artworkImageDataUrl: string | null;
  previewUnavailable: boolean;
}): ArtworkProofData {
  const requestedWidthIn = input.customWidth ?? input.sizeTierWidth;
  const requestedHeightIn = input.customHeight ?? input.sizeTierHeight;
  const widthIn = input.measuredWidthIn ?? requestedWidthIn;
  const heightIn = input.measuredHeightIn ?? requestedHeightIn;
  const sizeLabel =
    widthIn && heightIn
      ? `${formatInches(widthIn)}" W x ${formatInches(heightIn)}" H`
      : (input.sizeTierLabel ?? "Size not yet specified");

  let sizeMismatchWarning: string | null = null;
  if (
    input.measuredWidthIn != null &&
    input.measuredHeightIn != null &&
    requestedWidthIn != null &&
    requestedHeightIn != null &&
    (Math.abs(input.measuredWidthIn - requestedWidthIn) > SIZE_MISMATCH_TOLERANCE_IN ||
      Math.abs(input.measuredHeightIn - requestedHeightIn) > SIZE_MISMATCH_TOLERANCE_IN)
  ) {
    sizeMismatchWarning = `Requested size ${formatInches(requestedWidthIn)}" x ${formatInches(requestedHeightIn)}" doesn't match the uploaded file's measured size ${formatInches(input.measuredWidthIn)}" x ${formatInches(input.measuredHeightIn)}" -- please review before approving.`;
  }

  return {
    jobCode: input.jobCode,
    companyName: input.companyName,
    projectName: input.boothNumber ? `${input.showName} — Booth ${input.boothNumber}` : input.showName,
    date: input.date.toISOString().slice(0, 10),
    revision: input.revisionRound,
    description: input.material ?? "Booth graphic",
    fileName: input.fileName ?? "—",
    material: input.material ?? "Not specified",
    qty: input.qty,
    sizeLabel,
    widthIn,
    heightIn,
    bleedIn: input.bleedIn,
    sizeMismatchWarning,
    preparedBy: input.ownerName ?? "Unassigned",
    artworkImageDataUrl: input.artworkImageDataUrl,
    previewUnavailable: input.previewUnavailable,
  };
}

function formatInches(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

const styles = StyleSheet.create({
  page: { fontFamily: "Helvetica", color: BRAND.black, fontSize: 9 },
  headerBand: { backgroundColor: BRAND.navy, padding: 16, flexDirection: "row", justifyContent: "space-between" },
  // flexGrow + flexBasis: 0 (not minWidth, which only sets a floor and lets
  // long text overflow into the next field) -- this is what actually makes
  // Yoga divide the row's real width proportionally and wrap each field's
  // text inside its own share of it. Ratios sized for typical content
  // length: Project (client's show/booth) needs the most room, Date/
  // Revision the least.
  headerFieldGroup: { flexDirection: "row", flex: 1, marginRight: 12 },
  headerField: { flexGrow: 1, flexBasis: 0, paddingRight: 8 },
  headerLabel: { fontSize: 6.5, color: BRAND.gray, textTransform: "uppercase", letterSpacing: 0.5 },
  headerValue: { fontSize: 9, color: BRAND.white, fontWeight: 700, marginTop: 2, lineHeight: 1.25 },
  headerLogo: { width: 90, height: 31 },
  detailsStrip: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#d4d4d4",
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  detailsCol: { flex: 1, paddingRight: 12 },
  detailsLabel: { fontSize: 7, color: "#737373", textTransform: "uppercase", letterSpacing: 0.5 },
  detailsValue: { fontSize: 9, marginTop: 2 },
  thirdStrip: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#d4d4d4",
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  body: { paddingHorizontal: 24 },
  lineHeading: { fontSize: 20, fontWeight: 700, color: BRAND.tangerine, fontStyle: "italic", marginBottom: 4 },
  lineNote: { fontSize: 9, fontStyle: "italic", color: BRAND.navy, marginBottom: 24 },
  diagramWrap: { alignItems: "center" },
  dimLabel: { fontSize: 8, color: "#404040" },
  qtyBadge: {
    marginTop: 14,
    alignSelf: "center",
    backgroundColor: BRAND.tangerine,
    color: BRAND.white,
    fontSize: 9,
    fontWeight: 700,
    paddingVertical: 4,
    paddingHorizontal: 14,
    borderRadius: 3,
  },
  unavailableBox: {
    marginTop: 40,
    alignSelf: "center",
    padding: 24,
    borderWidth: 1,
    borderColor: "#d4d4d4",
    borderStyle: "dashed",
  },
  unavailableText: { fontSize: 10, color: "#737373", textAlign: "center" },
  mismatchWarning: {
    backgroundColor: "#fdf3e0",
    borderWidth: 1,
    borderColor: BRAND.tangerine,
    borderRadius: 3,
    padding: 8,
    marginBottom: 16,
  },
  mismatchWarningText: { fontSize: 8.5, color: "#7a4a00", lineHeight: 1.4 },
  bleedLabel: { fontSize: 7, color: BRAND.tangerine, fontWeight: 700 },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  footerDisclaimer: { backgroundColor: "#f5f4f0", padding: 10 },
  footerDisclaimerText: { fontSize: 7, color: "#404040", textAlign: "center", lineHeight: 1.4 },
  footerBar: { backgroundColor: BRAND.tangerine, paddingVertical: 4 },
  footerBarText: { fontSize: 7, color: BRAND.black, textAlign: "center", fontWeight: 700 },
  fullBleedImage: { width: "100%", height: "100%", objectFit: "contain" },
});

// Max box the artwork image itself may occupy (points) -- a fixed
// printable area; the image is always scaled to fit inside it while
// preserving the artwork's real aspect ratio, same reasoning
// cut-sheet-pdf.tsx's own DIAGRAM_MAX_WIDTH/HEIGHT documents. The width
// arrow lives above this box, the height arrow to its left, both drawn
// with real react-pdf absolute positioning (Yoga layout supports it
// directly -- no negative-margin overlap hacks needed).
const DIAGRAM_MAX_WIDTH = 420;
const DIAGRAM_MAX_HEIGHT = 240;
const ARROW_GUTTER = 28; // space reserved for each dimension arrow + its label

function DimensionedArtwork({ data }: { data: ArtworkProofData }) {
  if (!data.artworkImageDataUrl) {
    return (
      <View style={styles.unavailableBox}>
        <Text style={styles.unavailableText}>
          {data.previewUnavailable
            ? "Preview not available for this file type. Download the source file to view it."
            : "No artwork file on this order yet."}
        </Text>
      </View>
    );
  }

  const aspect = data.widthIn && data.heightIn ? data.widthIn / data.heightIn : 1.4;
  let imgWidth = DIAGRAM_MAX_WIDTH;
  let imgHeight = imgWidth / aspect;
  if (imgHeight > DIAGRAM_MAX_HEIGHT) {
    imgHeight = DIAGRAM_MAX_HEIGHT;
    imgWidth = imgHeight * aspect;
  }
  const totalWidth = imgWidth + ARROW_GUTTER;
  const totalHeight = imgHeight + ARROW_GUTTER;

  return (
    <View style={[styles.diagramWrap, { alignItems: "flex-start" }]}>
      <View style={{ position: "relative", width: totalWidth, height: totalHeight, alignSelf: "center" }}>
        {/* Width arrow + label, above the image */}
        <View style={{ position: "absolute", top: 0, left: ARROW_GUTTER, width: imgWidth, height: ARROW_GUTTER }}>
          <Svg width={imgWidth} height={12} style={{ marginTop: 4 }}>
            <Line x1={0} y1={6} x2={imgWidth} y2={6} stroke={BRAND.black} strokeWidth={0.75} />
            <Polygon points={`0,6 5,3 5,9`} fill={BRAND.black} />
            <Polygon points={`${imgWidth},6 ${imgWidth - 5},3 ${imgWidth - 5},9`} fill={BRAND.black} />
          </Svg>
          {data.widthIn != null && (
            <Text style={[styles.dimLabel, { textAlign: "center", marginTop: 2 }]}>{formatInches(data.widthIn)} in</Text>
          )}
        </View>

        {/* Height arrow + label, left of the image */}
        <View
          style={{
            position: "absolute",
            top: ARROW_GUTTER,
            left: 0,
            width: ARROW_GUTTER,
            height: imgHeight,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Svg width={12} height={imgHeight}>
            <Line x1={6} y1={0} x2={6} y2={imgHeight} stroke={BRAND.black} strokeWidth={0.75} />
            <Polygon points={`6,0 3,5 9,5`} fill={BRAND.black} />
            <Polygon points={`6,${imgHeight} 3,${imgHeight - 5} 9,${imgHeight - 5}`} fill={BRAND.black} />
          </Svg>
          {data.heightIn != null && (
            <Text style={[styles.dimLabel, { position: "absolute", left: -8 }]}>{formatInches(data.heightIn)} in</Text>
          )}
        </View>

        {/* The artwork image itself */}
        <View style={{ position: "absolute", top: ARROW_GUTTER, left: ARROW_GUTTER, width: imgWidth, height: imgHeight }}>
          <PdfImage src={data.artworkImageDataUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </View>

        {/* Bleed line: a dashed inset drawn proportionally off the real
            width/height (never off the fallback 1.4 aspect ratio used when
            those are unknown) -- otherwise the line would claim a precision
            about the print size this sheet doesn't actually have. */}
        {data.bleedIn != null && data.widthIn != null && data.heightIn != null && (
          <BleedOverlay data={data} imgWidth={imgWidth} imgHeight={imgHeight} />
        )}
      </View>
    </View>
  );
}

function BleedOverlay({
  data,
  imgWidth,
  imgHeight,
}: {
  data: ArtworkProofData;
  imgWidth: number;
  imgHeight: number;
}) {
  const bleedIn = data.bleedIn!;
  const widthIn = data.widthIn!;
  const heightIn = data.heightIn!;
  const insetX = (bleedIn / widthIn) * imgWidth;
  const insetY = (bleedIn / heightIn) * imgHeight;

  return (
    <View
      style={{ position: "absolute", top: ARROW_GUTTER, left: ARROW_GUTTER, width: imgWidth, height: imgHeight }}
    >
      <Svg width={imgWidth} height={imgHeight}>
        <Rect
          x={insetX}
          y={insetY}
          width={Math.max(imgWidth - insetX * 2, 0)}
          height={Math.max(imgHeight - insetY * 2, 0)}
          stroke={BRAND.tangerine}
          strokeWidth={1}
          strokeDasharray="4,3"
          fill="none"
        />
      </Svg>
      <Text style={[styles.bleedLabel, { position: "absolute", top: insetY + 2, left: insetX + 3 }]}>
        +{formatInches(bleedIn)}in bleed
      </Text>
    </View>
  );
}

function ProofFooter() {
  return (
    <View style={styles.footer} fixed>
      <View style={styles.footerDisclaimer}>
        <Text style={styles.footerDisclaimerText}>
          This document is for proofing purposes only -- it does not reflect final print color, and the image may
          appear compressed. Please confirm image, quantity, print size, and material match your order before
          approving this proof.
        </Text>
      </View>
      <View style={styles.footerBar}>
        <Text style={styles.footerBarText}>
          © {new Date().getFullYear()} {BRAND_COMPANY_NAME}. All rights reserved.
        </Text>
      </View>
    </View>
  );
}

function HeaderBand({ data }: { data: ArtworkProofData }) {
  return (
    <View style={styles.headerBand}>
      <View style={styles.headerFieldGroup}>
        <View style={[styles.headerField, { flexGrow: 0.9 }]}>
          <Text style={styles.headerLabel}>Job Code</Text>
          <Text style={styles.headerValue}>{data.jobCode}</Text>
        </View>
        <View style={[styles.headerField, { flexGrow: 1.3 }]}>
          <Text style={styles.headerLabel}>Client</Text>
          <Text style={styles.headerValue}>{data.companyName}</Text>
        </View>
        <View style={[styles.headerField, { flexGrow: 1.9 }]}>
          <Text style={styles.headerLabel}>Project</Text>
          <Text style={styles.headerValue}>{data.projectName}</Text>
        </View>
        <View style={[styles.headerField, { flexGrow: 0.7 }]}>
          <Text style={styles.headerLabel}>Date</Text>
          <Text style={styles.headerValue}>{data.date}</Text>
        </View>
        <View style={[styles.headerField, { flexGrow: 0.5, paddingRight: 0 }]}>
          <Text style={styles.headerLabel}>Revision</Text>
          <Text style={styles.headerValue}>{data.revision}</Text>
        </View>
      </View>
      <PdfImage src={LOGO_PATH} style={styles.headerLogo} />
    </View>
  );
}

function DetailsStrip({ data }: { data: ArtworkProofData }) {
  return (
    <>
      <View style={styles.detailsStrip}>
        <View style={styles.detailsCol}>
          <Text style={styles.detailsLabel}>Description</Text>
          <Text style={styles.detailsValue}>{data.description}</Text>
        </View>
        <View style={styles.detailsCol}>
          <Text style={styles.detailsLabel}>File Name</Text>
          <Text style={styles.detailsValue}>{data.fileName}</Text>
        </View>
      </View>
      <View style={styles.thirdStrip}>
        <View style={styles.detailsCol}>
          <Text style={styles.detailsLabel}>Qty</Text>
          <Text style={styles.detailsValue}>{data.qty}</Text>
        </View>
        <View style={styles.detailsCol}>
          <Text style={styles.detailsLabel}>Material</Text>
          <Text style={styles.detailsValue}>{data.material}</Text>
        </View>
        <View style={styles.detailsCol}>
          <Text style={styles.detailsLabel}>Print Size</Text>
          <Text style={styles.detailsValue}>{data.sizeLabel}</Text>
        </View>
        <View style={styles.detailsCol}>
          <Text style={styles.detailsLabel}>Prepared By</Text>
          <Text style={styles.detailsValue}>{data.preparedBy}</Text>
        </View>
      </View>
    </>
  );
}

export function ArtworkProofPdfDocument({ data }: { data: ArtworkProofData }) {
  return (
    <Document title={`Proof — ${data.jobCode}`}>
      <Page size="LETTER" style={styles.page}>
        <HeaderBand data={data} />
        <DetailsStrip data={data} />
        <View style={styles.body}>
          {data.sizeMismatchWarning && (
            <View style={styles.mismatchWarning}>
              <Text style={styles.mismatchWarningText}>⚠ {data.sizeMismatchWarning}</Text>
            </View>
          )}
          <Text style={styles.lineHeading}>{data.description}</Text>
          <Text style={styles.lineNote}>Review the layout below against your approved artwork before signing off.</Text>
          <DimensionedArtwork data={data} />
          <Text style={styles.qtyBadge}>QTY: {data.qty}</Text>
        </View>
        <ProofFooter />
      </Page>
      {data.artworkImageDataUrl && (
        <Page size="LETTER" style={styles.page}>
          <HeaderBand data={data} />
          <DetailsStrip data={data} />
          <View style={{ paddingHorizontal: 24, paddingTop: 8, paddingBottom: 60, flex: 1 }}>
            <PdfImage src={data.artworkImageDataUrl} style={styles.fullBleedImage} />
          </View>
          <ProofFooter />
        </Page>
      )}
    </Document>
  );
}
