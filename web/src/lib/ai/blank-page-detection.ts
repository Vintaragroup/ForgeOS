// Real incident (Titleist "Concept V1E" upload, Sept 2026): a 31-page
// drawing PDF sat at extractionStatus PENDING forever because every page
// rendered as a completely blank white image -- confirmed via `pdfimages
// -list` that every embedded image in the source file is JPEG2000 (jpx)
// encoded, and confirmed via drawing-summary-service.ts's own rendering
// path (`renderPageAsImage`, backed by @napi-rs/canvas's bundled PDF.js)
// that its JPX decoder fails to initialize (`JpxError: OpenJPEG failed to
// initialize`) and silently produces a blank canvas instead of throwing.
// The source file itself is valid -- extracting the same image with a
// working decoder (poppler's pdfimages + ImageMagick, tested directly
// against this exact file) decoded it perfectly. Without this check, a
// blank page still gets sent to the vision AI as if it were real content:
// no crash, no error, just wasted AI-vision cost on garbage input with no
// signal to the user about why.
//
// Detection approach: a cheap byte-size pre-filter (a real photo/drawing
// compresses to well above SUSPICIOUSLY_SMALL_BYTES; a solid-color canvas
// compresses to a few KB regardless of resolution) skips a full image
// decode on the common, non-blank case, followed by a downscale-and-
// sample pixel-uniformity check for anything that IS small enough to be
// suspicious. Byte-size alone would false-positive on a genuinely sparse
// CAD sheet (thin lines, light label density) that also compresses small
// -- pixel uniformity is the reliable signal, confirmed against the real
// failure case: a JPX-decode failure leaves the canvas completely
// untouched, with no other vector content on these full-page-raster
// sheets to produce any variation.
import { createCanvas, loadImage } from "@napi-rs/canvas";

const SUSPICIOUSLY_SMALL_BYTES = 150_000;
// Point-sample grid, ~64x64 -- deliberately TRUE point samples taken
// directly from the full-resolution decoded image (see below), not a
// blended/smoothed downscale. A blended downscale (drawImage scaling the
// whole page down to a small canvas) was tried first and rejected: it
// area-averages every destination pixel from a large block of source
// pixels, which washes out exactly the kind of sparse content a real CAD
// sheet has (thin dimension lines, modest label density) into a
// near-uniform tint indistinguishable from genuinely blank -- confirmed
// live, a real drawn-content test fixture false-positived as blank under
// that approach. True point sampling only reads actual pixel values, so
// it can't be fooled by averaging, at the cost of a (small, bounded)
// chance a real but extremely sparse page slips between sample points.
const SAMPLE_GRID = 64;
// Tolerance per RGB channel vs. the first sampled pixel -- covers PNG
// compression noise on a genuinely blank page while still tripping
// easily on real black-line-on-white drawing content.
const CHANNEL_TOLERANCE = 8;

export async function isBlankPageImage(dataUrl: string): Promise<boolean> {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > SUSPICIOUSLY_SMALL_BYTES) return false; // cheap fast path, no decode

  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0); // native size, no scaling -- every pixel read below is a real decoded pixel
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);

  const stepX = Math.max(1, Math.floor(width / SAMPLE_GRID));
  const stepY = Math.max(1, Math.floor(height / SAMPLE_GRID));
  let r0 = -1;
  let g0 = 0;
  let b0 = 0;
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const idx = (y * width + x) * 4;
      if (r0 === -1) {
        r0 = data[idx];
        g0 = data[idx + 1];
        b0 = data[idx + 2];
        continue;
      }
      if (
        Math.abs(data[idx] - r0) > CHANNEL_TOLERANCE ||
        Math.abs(data[idx + 1] - g0) > CHANNEL_TOLERANCE ||
        Math.abs(data[idx + 2] - b0) > CHANNEL_TOLERANCE
      ) {
        return false; // real variation found at a sampled point -- not blank
      }
    }
  }
  return true; // every sampled point matches the first -- uniform/blank
}
