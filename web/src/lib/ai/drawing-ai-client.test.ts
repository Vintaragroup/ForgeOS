import { describe, expect, it } from "vitest";
import { buildPageContentParts } from "@/lib/ai/drawing-ai-client";

describe("buildPageContentParts", () => {
  it("interleaves each page's text directly before its own image, in page order", () => {
    const images = ["data:image/png;base64,AAA", "data:image/png;base64,BBB"];
    const pageTexts = ["QTY 4 16 HOLE X 39 HOLE", "SHOE DISPLAY - QTY 2"];

    const parts = buildPageContentParts(images, pageTexts, [1, 2]);

    expect(parts).toEqual([
      { type: "text", text: expect.stringContaining("Page 1 extracted text") },
      { type: "image_url", image_url: { url: images[0] } },
      { type: "text", text: expect.stringContaining("Page 2 extracted text") },
      { type: "image_url", image_url: { url: images[1] } },
    ]);
    expect((parts[0] as { text: string }).text).toContain(pageTexts[0]);
    expect((parts[2] as { text: string }).text).toContain(pageTexts[1]);
  });

  it("marks a page with no extracted text as vision-only instead of an empty or missing text block", () => {
    const parts = buildPageContentParts(["data:image/png;base64,AAA"], [""], [1]);

    // Still one text part per page even when there's no real text -- the
    // model gets an explicit "nothing here, read the image" signal instead
    // of silently missing a page's worth of context or wondering whether
    // extraction just failed.
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({
      type: "text",
      text: expect.stringContaining("no extracted text layer available"),
    });
  });

  it("returns an empty array for an empty page list", () => {
    expect(buildPageContentParts([], [], [])).toEqual([]);
  });

  // Regression coverage: pageImages can now exclude a blank/undecodable
  // page mid-sequence (see blank-page-detection.ts), so images[i] is no
  // longer implicitly page i+1 -- a caller (or the model reading its own
  // "Page N" labels) needs the TRUE source page number, which can skip
  // values, not the array position.
  it("labels each page with its true source page number, not its array position, when earlier pages were skipped", () => {
    const images = ["data:image/png;base64,AAA", "data:image/png;base64,BBB"];
    const pageTexts = ["FIRST REAL PAGE", "SECOND REAL PAGE"];
    // Page 2 was dropped as blank -- these two images are really pages 1 and 3.
    const parts = buildPageContentParts(images, pageTexts, [1, 3]);

    expect((parts[0] as { text: string }).text).toContain("Page 1");
    expect((parts[2] as { text: string }).text).toContain("Page 3");
    expect((parts[2] as { text: string }).text).not.toContain("Page 2");
  });
});
