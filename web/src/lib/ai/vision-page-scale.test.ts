import { describe, expect, it } from "vitest";
import {
  chunkPagesByBudget,
  dataUrlBytes,
  visionPageScale,
  VISION_MAX_SCALE,
  VISION_MIN_SCALE,
} from "@/lib/ai/vision-page-scale";

// dataUrlBytes measures what goes on the wire, so a URL of N transmitted
// bytes is simply N characters long.
function dataUrlOfBytes(bytes: number): string {
  return `data:image/png;base64,${"A".repeat(Math.max(0, bytes - 22))}`;
}

describe("visionPageScale", () => {
  // The behaviour that must not regress: the flat scale of 2 existed so
  // small dimension labels stay legible, and a normal page still gets it.
  it("leaves a letter page at the full 2x it always had", () => {
    expect(visionPageScale(612, 792)).toBe(VISION_MAX_SCALE);
  });

  // Tabloid at a flat 2x is 2448px on the long edge -- already past the
  // ceiling the provider resamples to, so it gets fitted rather than
  // rendered large and then thrown away.
  it("fits a tabloid page to the ceiling instead of overshooting it", () => {
    const scale = visionPageScale(792, 1224);
    expect(scale).toBeLessThan(VISION_MAX_SCALE);
    expect(1224 * scale).toBeLessThanOrEqual(2000);
    expect(1224 * scale).toBeGreaterThan(1900);
  });

  // Full Swing's drawing. At the old flat 2x this page alone rendered
  // 6048 x 4320 -- 26 megapixels -- and several of them together blew the
  // provider's 30MB ceiling, failing the whole analysis.
  it("scales an ARCH E sheet down to land near the vision ceiling", () => {
    const scale = visionPageScale(3024, 2160);
    expect(scale).toBeLessThan(1);
    // The long edge ends up near 2000px rather than 6048.
    expect(3024 * scale).toBeGreaterThan(1900);
    expect(3024 * scale).toBeLessThanOrEqual(2000);
  });

  // Downscaling past the ceiling costs nothing the model would have
  // seen, but a pathologically large page still should not collapse.
  it("floors at a sanity minimum for an absurdly large page", () => {
    expect(visionPageScale(12000, 8000)).toBe(VISION_MIN_SCALE);
  });

  it("falls back to the full scale on a nonsense page size", () => {
    expect(visionPageScale(0, 0)).toBe(VISION_MAX_SCALE);
    expect(visionPageScale(Number.NaN, 100)).toBe(VISION_MAX_SCALE);
  });

  it("is orientation-agnostic", () => {
    expect(visionPageScale(3024, 2160)).toBe(visionPageScale(2160, 3024));
  });
});

describe("dataUrlBytes", () => {
  // The provider counts what it receives -- the base64 text -- not the
  // image that decodes out of it. Measuring the decoded size instead was
  // wrong by exactly the 4/3 base64 ratio, which is how 14 pages
  // "within budget" were rejected at 32MB on the wire.
  it("measures the transmitted size, not the decoded size", () => {
    const url = dataUrlOfBytes(9000);
    expect(dataUrlBytes(url)).toBe(url.length);
    expect(dataUrlBytes(url)).toBe(9000);
  });
});

describe("chunkPagesByBudget", () => {
  it("keeps one request when everything fits", () => {
    const pages = [1, 2, 3].map((n) => ({ n, dataUrl: dataUrlOfBytes(1000) }));
    expect(chunkPagesByBudget(pages, 10_000)).toHaveLength(1);
  });

  // The whole point: 14 legible sheets across a few requests beats 14
  // illegible ones in a single request, and beats a 413.
  it("splits into consecutive runs rather than dropping or shrinking", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => ({ n, dataUrl: dataUrlOfBytes(4000) }));
    const chunks = chunkPagesByBudget(pages, 10_000);
    expect(chunks.map((c) => c.map((p) => p.n))).toEqual([[1, 2], [3, 4], [5]]);
    // Nothing is lost.
    expect(chunks.flat()).toHaveLength(5);
  });

  it("gives an oversized page a request of its own rather than dropping it", () => {
    const pages = [
      { n: 1, dataUrl: dataUrlOfBytes(2000) },
      { n: 2, dataUrl: dataUrlOfBytes(50_000) },
      { n: 3, dataUrl: dataUrlOfBytes(2000) },
    ];
    const chunks = chunkPagesByBudget(pages, 10_000);
    expect(chunks.map((c) => c.map((p) => p.n))).toEqual([[1], [2], [3]]);
  });

  it("returns nothing for no pages", () => {
    expect(chunkPagesByBudget([], 10_000)).toEqual([]);
  });
});
