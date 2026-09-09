import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { summarizeDrawing, pageImages } from "@/lib/ai/drawing-summary-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");
const REAL_CAD_PDF = path.resolve(
  import.meta.dirname,
  "../../../../data/historical_jobs/pdf/LED skins PolyCad.pdf",
);
const REAL_PNG = path.resolve(import.meta.dirname, "../../../public/brand/expo-logo-black.png");

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeDrawingDocument(filename: string, mimeType: string, bytes: Buffer) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const file = new File([new Uint8Array(bytes)], filename, { type: mimeType });
  return uploadDocument(opportunity.id, { file, documentType: "DRAWING" });
}

describe("summarizeDrawing", () => {
  // OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
  // document-summary-service.test.ts: this verifies the "AI features not
  // configured" path, not a real vision call (that needs a real key,
  // tested manually per this feature's own plan).
  it("throws AiNotConfiguredError before touching the document, leaving it PENDING and retryable", async () => {
    const bytes = await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));
    const document = await makeDrawingDocument("drawing.pdf", PDF_MIME, bytes);

    await expect(summarizeDrawing(document.id)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const refreshed = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(refreshed.extractionStatus).toBe("PENDING");
  });
});

describe("pageImages", () => {
  it(
    "rasterizes a real multi-page CAD PDF into one data URL per page, and reports the real totalPages under the default cap",
    async () => {
      const bytes = await readFile(REAL_CAD_PDF);
      const { images, totalPages, pageTexts } = await pageImages(PDF_MIME, bytes);

      // This fixture has 11 real pages, comfortably under MAX_DRAWING_PAGES
      // (20) -- nothing truncated, images.length matches totalPages exactly.
      expect(totalPages).toBe(11);
      expect(images).toHaveLength(11);
      for (const image of images) {
        expect(image).toMatch(/^data:image\/png;base64,/);
      }

      // This fixture (an email thread about LED tile pricing, despite its
      // "CAD" filename) has a real, substantial text layer on every page --
      // confirms pageTexts is genuinely populated from the PDF's own text,
      // parallel-indexed to images, not just a same-length array of blanks.
      expect(pageTexts).toHaveLength(11);
      expect(pageTexts[0]).toContain("Craig Wells");
      for (const text of pageTexts) {
        expect(text.length).toBeGreaterThan(0);
      }
    },
    30_000, // rasterizing 11 pages at scale 2 is real, non-trivial canvas work -- default 5s timeout isn't enough
  );

  it(
    "caps at the given maxPages and still reports the real totalPages, so a caller can detect truncation",
    async () => {
      const bytes = await readFile(REAL_CAD_PDF);
      const { images, totalPages, pageTexts } = await pageImages(PDF_MIME, bytes, 3);

      expect(images).toHaveLength(3);
      expect(totalPages).toBe(11);
      // pageTexts stays capped to the same 3 pages as images -- extractPdfPageTexts
      // itself has no maxPages concept, so pageImages must slice it down to match.
      expect(pageTexts).toHaveLength(3);
      for (const image of images) {
        expect(image).toMatch(/^data:image\/png;base64,/);
      }
    },
    30_000,
  );

  it("passes a raw image straight through as one page, no rasterization, with no text layer", async () => {
    const bytes = await readFile(REAL_PNG);
    const { images, totalPages, pageTexts } = await pageImages("image/png", bytes);

    expect(images).toHaveLength(1);
    expect(totalPages).toBe(1);
    expect(images[0]).toBe(`data:image/png;base64,${bytes.toString("base64")}`);
    // A raw image has no PDF text layer at all -- "" is the same
    // "vision only for this page" signal a text-extraction failure or a
    // genuinely text-free PDF page falls back to.
    expect(pageTexts).toEqual([""]);
  });

  it("throws for a mime type it doesn't know how to turn into page images", async () => {
    await expect(pageImages("application/octet-stream", Buffer.from("x"))).rejects.toThrow(
      /Unsupported file type for drawing analysis/,
    );
  });
});
