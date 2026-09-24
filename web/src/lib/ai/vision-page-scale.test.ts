import { describe, expect, it } from "vitest";
import {
  dataUrlBytes,
  fitPagesToBudget,
  visionPageScale,
  VISION_MAX_SCALE,
  VISION_MIN_SCALE,
} from "@/lib/ai/vision-page-scale";

function dataUrlOfBytes(bytes: number): string {
  // 4 base64 chars per 3 bytes.
  return `data:image/png;base64,${"A".repeat(Math.ceil((bytes * 4) / 3))}`;
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
  it("estimates the decoded size of a data URL", () => {
    expect(dataUrlBytes(dataUrlOfBytes(9000))).toBeGreaterThan(8800);
    expect(dataUrlBytes(dataUrlOfBytes(9000))).toBeLessThan(9200);
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
