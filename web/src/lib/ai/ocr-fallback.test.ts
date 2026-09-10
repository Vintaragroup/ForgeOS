import { describe, expect, it } from "vitest";
import { createCanvas } from "@napi-rs/canvas";
import { PDFDocument } from "pdf-lib";
import { ocrDocumentText } from "@/lib/ai/ocr-fallback";

function textImageBytes(text: string): Buffer {
  const canvas = createCanvas(900, 200);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, 900, 200);
  ctx.fillStyle = "black";
  ctx.font = "36px sans-serif";
  ctx.fillText(text, 20, 100);
  const dataUrl = canvas.toDataURL();
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

// A genuinely scanned-page-shaped fixture: a PDF page with an embedded
// RASTER image of text (via pdf-lib's embedPng), not pdf-lib's own vector
// drawText -- the latter would create a real searchable text layer, which
// extractDocumentText's regular unpdf extraction would already find,
// never reaching this OCR fallback at all. Confirmed directly this
// session: unpdf's own extractText on this fixture returns "".
async function scannedPdfBytes(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([900, 200]);
  const img = await doc.embedPng(textImageBytes(text));
  page.drawImage(img, { x: 0, y: 0, width: 900, height: 200 });
  return Buffer.from(await doc.save());
}

async function blankPdfBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([900, 200]); // no drawn content -- genuinely blank
  return Buffer.from(await doc.save());
}

describe("ocrDocumentText", () => {
  it(
    "recovers real text from a scanned (no-text-layer) PDF page via rasterize-then-OCR",
    async () => {
      const bytes = await scannedPdfBytes("CONTRACT NO 4521");
      const text = await ocrDocumentText("application/pdf", bytes);
      expect(text).toContain("CONTRACT NO 4521");
    },
    30_000,
  );

  it(
    "recovers real text from a raw scanned image upload (no PDF wrapper)",
    async () => {
      const bytes = textImageBytes("VENDOR SERVICES AGREEMENT");
      const text = await ocrDocumentText("image/png", bytes);
      expect(text).toContain("VENDOR SERVICES AGREEMENT");
    },
    30_000,
  );

  it(
    "returns an empty string for a genuinely blank PDF page, without attempting OCR on it",
    async () => {
      const bytes = await blankPdfBytes();
      const text = await ocrDocumentText("application/pdf", bytes);
      expect(text).toBe("");
    },
    30_000,
  );

  it("returns an empty string for an unhandled mimeType, never throwing", async () => {
    const text = await ocrDocumentText("application/octet-stream", Buffer.from("x"));
    expect(text).toBe("");
  });
});
