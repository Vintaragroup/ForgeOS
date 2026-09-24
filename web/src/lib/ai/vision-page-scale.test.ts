import { describe, expect, it } from "vitest";
import {
  dataUrlBytes,
  fitPagesToBudget,
  shrinkFactorForBudget,
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

describe("shrinkFactorForBudget", () => {
  it("leaves a set that already fits alone", () => {
    expect(shrinkFactorForBudget(10, 20)).toBe(1);
    expect(shrinkFactorForBudget(0, 20)).toBe(1);
  });

  // Encoded size tracks pixel area, which is the square of the linear
  // scale -- so halving the bytes means scaling by roughly 1/sqrt(2).
  it("shrinks by roughly the square root of the overshoot", () => {
    const f = shrinkFactorForBudget(40, 20);
    expect(f).toBeGreaterThan(0.55);
    expect(f).toBeLessThan(0.72);
    // Applying it lands under budget, with headroom.
    expect(40 * f * f).toBeLessThan(20);
  });

  it("refuses to shrink a page into illegibility however far over budget", () => {
    expect(shrinkFactorForBudget(10_000, 1)).toBe(0.3);
  });
});

describe("fitPagesToBudget", () => {
  it("keeps everything when it all fits", () => {
    const pages = [1, 2, 3].map((n) => ({ n, dataUrl: dataUrlOfBytes(1000) }));
    const { kept, dropped } = fitPagesToBudget(pages, 10_000);
    expect(kept).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  // A 413 returns nothing at all, so a partial drawing beats none -- and
  // the caller is told which pages went missing rather than silently
  // analysing an incomplete set.
  it("drops the tail rather than blowing the budget", () => {
    const pages = [1, 2, 3, 4].map((n) => ({ n, dataUrl: dataUrlOfBytes(4000) }));
    const { kept, dropped } = fitPagesToBudget(pages, 10_000);
    expect(kept.map((p) => p.n)).toEqual([1, 2]);
    expect(dropped.map((p) => p.n)).toEqual([3, 4]);
  });

  it("always keeps the first page even when it alone exceeds the budget", () => {
    const pages = [{ n: 1, dataUrl: dataUrlOfBytes(50_000) }, { n: 2, dataUrl: dataUrlOfBytes(50_000) }];
    const { kept, dropped } = fitPagesToBudget(pages, 10_000);
    expect(kept.map((p) => p.n)).toEqual([1]);
    expect(dropped.map((p) => p.n)).toEqual([2]);
  });
});
