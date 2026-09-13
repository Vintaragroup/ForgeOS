// Automated first-pass signal for the EXPO_PROOF_CHECK review card -- a
// pixel-level diff between a vendor's proof and the client's originally
// approved artwork, alongside (not replacing) the existing manual
// side-by-side links. A human still makes the actual call; this just
// surfaces "how different do these actually look" before they do.
import { createCanvas } from "@napi-rs/canvas";
import pixelmatch from "pixelmatch";
import { rasterizePdfPageToCanvas, getPdfPageDimensionsInInches } from "@/lib/document-view-service";
import { SIZE_MISMATCH_TOLERANCE_IN, formatInches } from "@/lib/artwork-proof-pdf";

// Matches renderPdfPageToPng's own default -- not chosen independently, so
// a diff image reads at the same visual scale as every other rasterized
// artwork preview in this app.
const DIFF_RASTER_SCALE = 2;

export type ArtworkDiffResult =
  | { skipped: true; reason: string }
  | { skipped: false; diffPercent: number; diffImageDataUrl: string };

export async function diffArtworkPages(
  proofBytes: Buffer,
  approvedBytes: Buffer,
  pageNumber: number,
): Promise<ArtworkDiffResult> {
  // Comparing two genuinely different-sized prints pixel-for-pixel isn't
  // meaningful -- reuse the exact same real-inches measurement and
  // tolerance the proof sheet's own mismatch warning already established,
  // rather than a second, potentially-drifting threshold.
  const [proofDims, approvedDims] = await Promise.all([
    getPdfPageDimensionsInInches(proofBytes, pageNumber),
    getPdfPageDimensionsInInches(approvedBytes, pageNumber),
  ]);
  if (!proofDims || !approvedDims) {
    return {
      skipped: true,
      reason: "One or both files couldn't be measured, so an automatic visual comparison isn't available.",
    };
  }
  if (
    Math.abs(proofDims.widthIn - approvedDims.widthIn) > SIZE_MISMATCH_TOLERANCE_IN ||
    Math.abs(proofDims.heightIn - approvedDims.heightIn) > SIZE_MISMATCH_TOLERANCE_IN
  ) {
    return {
      skipped: true,
      reason: `Proof measures ${formatInches(proofDims.widthIn)}" x ${formatInches(proofDims.heightIn)}" vs. the approved artwork's ${formatInches(approvedDims.widthIn)}" x ${formatInches(approvedDims.heightIn)}" -- too different in size for a meaningful pixel comparison.`,
    };
  }

  const [proofCanvas, approvedCanvas] = await Promise.all([
    rasterizePdfPageToCanvas(proofBytes, pageNumber, DIFF_RASTER_SCALE),
    rasterizePdfPageToCanvas(approvedBytes, pageNumber, DIFF_RASTER_SCALE),
  ]);
  if (!proofCanvas || !approvedCanvas) {
    return { skipped: true, reason: "One or both files couldn't be rendered for comparison." };
  }

  // Real-world sizes already agree within tolerance, but two independently
  // rasterized PDFs can still land a handful of pixels apart from
  // rounding -- crop both to their shared top-left overlap (the smaller of
  // each dimension) rather than distorting either image to force an exact
  // match, which pixelmatch requires.
  const width = Math.min(proofCanvas.width, approvedCanvas.width);
  const height = Math.min(proofCanvas.height, approvedCanvas.height);

  const proofData = proofCanvas.getContext("2d").getImageData(0, 0, width, height).data;
  const approvedData = approvedCanvas.getContext("2d").getImageData(0, 0, width, height).data;

  const diffCanvas = createCanvas(width, height);
  const diffCtx = diffCanvas.getContext("2d");
  const diffImageData = diffCtx.createImageData(width, height);

  const mismatchedPixels = pixelmatch(proofData, approvedData, diffImageData.data, width, height, { threshold: 0.1 });
  diffCtx.putImageData(diffImageData, 0, 0);

  const buffer = await diffCanvas.encode("png");
  return {
    skipped: false,
    diffPercent: (mismatchedPixels / (width * height)) * 100,
    diffImageDataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
  };
}
