// How far to scale a PDF page up before sending it to a vision model.
//
// Drawings were rendered at a flat scale: 2, chosen because "native PDF
// DPI is often too low to read small dimension labels". That is true of a
// letter-size sheet. It is badly wrong for a large-format one: a booth
// rendering on an ARCH E sheet is ~3024 x 2160pt, so scale 2 produces a
// 6048 x 4320 image -- 26 megapixels, tens of MB as PNG, per page.
//
// Full Swing's 90x20 booth drawing failed exactly there, with
// "413 Downloaded image content cannot exceed 30MB" -- a 3.7MB PDF
// becoming more than 30MB of page images. That document is the one
// carrying the client's new design, so the failure was not cosmetic: it
// meant nothing downstream could see what had changed.
//
// The extra pixels bought nothing anyway. Vision models resample to
// roughly 2048px on the long edge, so everything past that is spent
// encoding, uploading, and then discarding detail.
//
// So: scale up small pages exactly as before, and scale large ones to
// land near that ceiling instead of far past it.

// The long edge, in pixels, to aim for. Sits just under the ~2048 the
// model will resample to, so a page arrives at the resolution it will
// actually be read at.
export const VISION_MAX_EDGE_PX = 2000;

// Unchanged for anything that already fitted: a letter page at scale 2 is
// 1224 x 1584, well inside the ceiling, and the small-label legibility
// that scale was chosen for is preserved.
export const VISION_MAX_SCALE = 2;

// A sanity floor, not a legibility one. Downscaling to the ceiling costs
// nothing real -- the provider resamples past it regardless, so those
// pixels were always going to be discarded -- but a pathologically large
// page should still not collapse to nothing.
export const VISION_MIN_SCALE = 0.25;

// widthPt/heightPt are the page's extent at scale 1, which for a PDF with
// the default userUnit is its size in points.
export function visionPageScale(widthPt: number, heightPt: number): number {
  const longestEdge = Math.max(widthPt, heightPt);
  if (!Number.isFinite(longestEdge) || longestEdge <= 0) return VISION_MAX_SCALE;

  const fitted = VISION_MAX_EDGE_PX / longestEdge;
  if (fitted >= VISION_MAX_SCALE) return VISION_MAX_SCALE;
  if (fitted <= VISION_MIN_SCALE) return VISION_MIN_SCALE;
  // Two decimals: the exact ratio carries no useful precision and a
  // rounder number makes the rendered size predictable in logs.
  return Math.round(fitted * 100) / 100;
}

// What the provider actually counts: the bytes it receives, which for a
// data URL is the base64 text itself, not the image it decodes to.
//
// Measured as decoded size first, and that was wrong by exactly the
// base64 ratio (4 bytes sent per 3 decoded). Fourteen pages estimated at
// 24MB decoded were 32MB on the wire, so nothing was dropped and the
// request was rejected anyway -- the guard reported success while the
// analysis failed.
export function dataUrlBytes(dataUrl: string): number {
  return dataUrl.length;
}

// The provider rejects a request whose images total more than 30MB, and
// that rejection costs the whole analysis rather than one page. Budgeted
// well below the limit: the request also carries every page's extracted
// text and the prompt, and an estimate that lands just under a hard
// ceiling is an estimate that eventually lands just over it.
export const VISION_TOTAL_IMAGE_BUDGET_BYTES = 20 * 1024 * 1024;

// Splitting the pages across requests, rather than shrinking them to fit
// one.
//
// The 30MB ceiling is per request, so a 14-sheet drawing does not have to
// choose between being rejected and being unreadable. Shrinking was tried
// first and is a false economy: re-rendered at 0.71x, Full Swing's 14
// sheets fitted in 18.6MB and the model then extracted nothing at all,
// because the dimension labels it is asked to read had stopped being
// legible. The same drawing's predecessor, analysed at full scale,
// yielded fourteen exact dimensions. Legibility is the whole product
// here; the request count is just billing.
//
// Greedy, and in page order, so each request still sees a run of
// consecutive sheets rather than a scatter. A single page larger than the
// budget gets a request to itself rather than being dropped.
export function chunkPagesByBudget<T extends { dataUrl: string }>(
  pages: T[],
  budgetBytes: number = VISION_TOTAL_IMAGE_BUDGET_BYTES,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let used = 0;

  for (const page of pages) {
    const size = dataUrlBytes(page.dataUrl);
    if (current.length > 0 && used + size > budgetBytes) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(page);
    used += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
