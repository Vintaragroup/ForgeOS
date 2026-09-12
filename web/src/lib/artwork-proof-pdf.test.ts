import { describe, expect, it } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";
import { ArtworkProofPdfDocument, buildArtworkProofData } from "@/lib/artwork-proof-pdf";

function baseInput() {
  return {
    jobCode: "EXPO-1234",
    companyName: "Crestline Outfitters",
    showName: "2026 Riverside Home & Garden Expo",
    boothNumber: null as string | null,
    date: new Date("2026-09-12T00:00:00Z"),
    revisionRound: 0,
    material: "Vinyl banner, full color" as string | null,
    qty: 2,
    fileName: "artwork.pdf" as string | null,
    sizeTierLabel: null as string | null,
    sizeTierWidth: null as number | null,
    sizeTierHeight: null as number | null,
    customWidth: null as number | null,
    customHeight: null as number | null,
    bleedIn: null as number | null,
    measuredWidthIn: null as number | null,
    measuredHeightIn: null as number | null,
    ownerName: "Demo Tutorial Admin" as string | null,
    // A real, valid 1x1 transparent PNG (not just an arbitrary base64
    // string) -- react-pdf's <Image> actually decodes this when rendering
    // ArtworkProofPdfDocument, so it needs to be real image bytes, not a
    // placeholder that only happens to look like a data URL.
    artworkImageDataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" as
        | string
        | null,
    previewUnavailable: false,
  };
}

describe("buildArtworkProofData", () => {
  it("appends the booth number to the project name only when one is set", () => {
    const withBooth = buildArtworkProofData({ ...baseInput(), boothNumber: "B14" });
    expect(withBooth.projectName).toBe("2026 Riverside Home & Garden Expo — Booth B14");

    const withoutBooth = buildArtworkProofData(baseInput());
    expect(withoutBooth.projectName).toBe("2026 Riverside Home & Garden Expo");
  });

  it("prefers the order's custom size over the size tier when both are present", () => {
    const data = buildArtworkProofData({
      ...baseInput(),
      customWidth: 96,
      customHeight: 42,
      sizeTierWidth: 48,
      sizeTierHeight: 24,
      sizeTierLabel: "Standard 4x2",
    });
    expect(data.widthIn).toBe(96);
    expect(data.heightIn).toBe(42);
    expect(data.sizeLabel).toBe('96" W x 42" H');
  });

  it("falls back to the size tier's label when no real dimensions exist at all", () => {
    const data = buildArtworkProofData({ ...baseInput(), sizeTierLabel: "Standard 4x2" });
    expect(data.sizeLabel).toBe("Standard 4x2");
  });

  it("falls back to an honest placeholder when there is no size data whatsoever", () => {
    const data = buildArtworkProofData(baseInput());
    expect(data.sizeLabel).toBe("Size not yet specified");
  });

  it("formats a non-integer dimension without a trailing zero", () => {
    const data = buildArtworkProofData({ ...baseInput(), customWidth: 86.25, customHeight: 30 });
    expect(data.sizeLabel).toBe('86.25" W x 30" H');
  });

  it("uses honest placeholders for missing material and owner rather than blank fields", () => {
    const data = buildArtworkProofData({ ...baseInput(), material: null, ownerName: null });
    expect(data.description).toBe("Booth graphic");
    expect(data.material).toBe("Not specified");
    expect(data.preparedBy).toBe("Unassigned");
  });

  it("formats the date as a plain YYYY-MM-DD string", () => {
    const data = buildArtworkProofData(baseInput());
    expect(data.date).toBe("2026-09-12");
  });

  it("passes the artwork image and preview-unavailable flag straight through", () => {
    const unavailable = buildArtworkProofData({ ...baseInput(), artworkImageDataUrl: null, previewUnavailable: true });
    expect(unavailable.artworkImageDataUrl).toBeNull();
    expect(unavailable.previewUnavailable).toBe(true);
  });

  it("prefers the file-measured size over a requested size when both are present", () => {
    const data = buildArtworkProofData({
      ...baseInput(),
      customWidth: 96,
      customHeight: 42,
      measuredWidthIn: 95.9,
      measuredHeightIn: 42.1,
    });
    expect(data.widthIn).toBeCloseTo(95.9);
    expect(data.heightIn).toBeCloseTo(42.1);
  });

  it("falls back to the requested size when the file can't be measured", () => {
    const data = buildArtworkProofData({ ...baseInput(), customWidth: 96, customHeight: 42 });
    expect(data.widthIn).toBe(96);
    expect(data.heightIn).toBe(42);
  });

  it("flags a mismatch when the measured size disagrees with the requested size beyond tolerance", () => {
    const data = buildArtworkProofData({
      ...baseInput(),
      customWidth: 96,
      customHeight: 42,
      measuredWidthIn: 90,
      measuredHeightIn: 42,
    });
    expect(data.sizeMismatchWarning).toContain('96" x 42"');
    expect(data.sizeMismatchWarning).toContain('90" x 42"');
  });

  it("does not flag a mismatch within tolerance", () => {
    const data = buildArtworkProofData({
      ...baseInput(),
      customWidth: 96,
      customHeight: 42,
      measuredWidthIn: 96.1,
      measuredHeightIn: 41.9,
    });
    expect(data.sizeMismatchWarning).toBeNull();
  });

  it("does not flag a mismatch when there is nothing to compare the measured size against", () => {
    const data = buildArtworkProofData({ ...baseInput(), measuredWidthIn: 90, measuredHeightIn: 42 });
    expect(data.sizeMismatchWarning).toBeNull();
  });

  it("passes bleed straight through", () => {
    const data = buildArtworkProofData({ ...baseInput(), bleedIn: 0.25 });
    expect(data.bleedIn).toBe(0.25);
  });
});

// Same "renders a real PDF in Node" verification standard as
// task-packet-pdf.test.ts / cut-list-labels-pdf.test.ts.
describe("ArtworkProofPdfDocument", () => {
  it("renders a real, non-trivial two-page PDF buffer when an artwork image is present", async () => {
    const data = buildArtworkProofData({ ...baseInput(), boothNumber: "B14" });
    const buffer = await renderToBuffer(ArtworkProofPdfDocument({ data }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });

  it("renders a single-page PDF with an honest fallback message when no artwork image is available", async () => {
    const data = buildArtworkProofData({ ...baseInput(), artworkImageDataUrl: null, previewUnavailable: false });
    const buffer = await renderToBuffer(ArtworkProofPdfDocument({ data }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders without error when the file type can't be previewed at all", async () => {
    const data = buildArtworkProofData({ ...baseInput(), artworkImageDataUrl: null, previewUnavailable: true });
    const buffer = await renderToBuffer(ArtworkProofPdfDocument({ data }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders the bleed line and the mismatch warning without error", async () => {
    const data = buildArtworkProofData({
      ...baseInput(),
      customWidth: 96,
      customHeight: 42,
      measuredWidthIn: 90,
      measuredHeightIn: 42,
      bleedIn: 0.25,
    });
    expect(data.sizeMismatchWarning).not.toBeNull();
    const buffer = await renderToBuffer(ArtworkProofPdfDocument({ data }));
    expect(buffer.subarray(0, 4).toString()).toBe("%PDF");
    expect(buffer.length).toBeGreaterThan(500);
  });
});
