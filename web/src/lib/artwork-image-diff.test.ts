import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderToBuffer, Document, Page, View } from "@react-pdf/renderer";
import { diffArtworkPages } from "@/lib/artwork-image-diff";

// Same createElement approach document-view-service.test.ts already
// established -- Document/Page/View are @react-pdf/renderer's own
// host-element type strings, not components, so this file (no JSX) has to
// build the tree directly rather than calling them.
async function makeSolidColorPdf(widthPt: number, heightPt: number, color: string): Promise<Buffer> {
  return renderToBuffer(
    createElement(
      Document,
      null,
      createElement(
        Page,
        { size: [widthPt, heightPt] },
        createElement(View, { style: { width: "100%", height: "100%", backgroundColor: color } }),
      ),
    ),
  );
}

describe("diffArtworkPages", () => {
  it("skips with a reason when a file isn't PDF-parseable", async () => {
    const validPdf = await makeSolidColorPdf(360, 360, "#ffffff");
    const notAPdf = Buffer.from("this is not a PDF file");
    const result = await diffArtworkPages(notAPdf, validPdf, 1);
    expect(result.skipped).toBe(true);
    if (result.skipped) expect(result.reason).toMatch(/couldn't be measured/i);
  });

  it("skips with a reason when the two files' real sizes disagree beyond tolerance", async () => {
    const proof = await makeSolidColorPdf(360, 360, "#ffffff"); // 5in x 5in
    const approved = await makeSolidColorPdf(720, 720, "#ffffff"); // 10in x 10in
    const result = await diffArtworkPages(proof, approved, 1);
    expect(result.skipped).toBe(true);
    if (result.skipped) {
      expect(result.reason).toContain('5" x 5"');
      expect(result.reason).toContain('10" x 10"');
    }
  });

  it("does not skip when the two files' real sizes agree within tolerance", async () => {
    const proof = await makeSolidColorPdf(360, 360, "#ffffff");
    const approved = await makeSolidColorPdf(360, 360, "#ffffff");
    const result = await diffArtworkPages(proof, approved, 1);
    expect(result.skipped).toBe(false);
  });

  it("reports a near-zero diff percent for two visually identical pages", async () => {
    const proof = await makeSolidColorPdf(360, 360, "#336699");
    const approved = await makeSolidColorPdf(360, 360, "#336699");
    const result = await diffArtworkPages(proof, approved, 1);
    expect(result.skipped).toBe(false);
    if (!result.skipped) expect(result.diffPercent).toBeLessThan(1);
  });

  it("reports a real diff percent for two visually different pages, and a real diff image", async () => {
    const proof = await makeSolidColorPdf(360, 360, "#000000");
    const approved = await makeSolidColorPdf(360, 360, "#ffffff");
    const result = await diffArtworkPages(proof, approved, 1);
    expect(result.skipped).toBe(false);
    if (!result.skipped) {
      expect(result.diffPercent).toBeGreaterThan(90);
      expect(result.diffImageDataUrl).toMatch(/^data:image\/png;base64,/);
      const base64 = result.diffImageDataUrl.slice("data:image/png;base64,".length);
      expect(Buffer.from(base64, "base64").length).toBeGreaterThan(100);
    }
  });

  it("skips with a reason when a requested page number is out of range for either file", async () => {
    const proof = await makeSolidColorPdf(360, 360, "#ffffff");
    const approved = await makeSolidColorPdf(360, 360, "#ffffff");
    const result = await diffArtworkPages(proof, approved, 99);
    expect(result.skipped).toBe(true);
  });
});
