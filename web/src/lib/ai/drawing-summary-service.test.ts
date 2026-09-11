import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, rgb } from "pdf-lib";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { summarizeDrawing, pageImages, SYSTEM_PROMPT } from "@/lib/ai/drawing-summary-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";

// Builds a small, deterministic multi-page PDF for exercising the blank-
// page-detection path (see blank-page-detection.ts's own header for the
// real incident this covers) without depending on a real JPEG2000 fixture
// file. pdf-lib is a devDependency only, never imported by production
// code -- a minimal valid PDF needs a hand-computed xref table, too
// fragile to hand-roll and maintain as a raw byte literal.
async function buildTestPdf(totalPages: number, blankPages: number[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= totalPages; i++) {
    const page = doc.addPage([200, 200]);
    if (!blankPages.includes(i)) {
      page.drawRectangle({ x: 20, y: 20, width: 160, height: 160, color: rgb(0, 0, 0) });
      page.drawText(`Page ${i} content`, { x: 20, y: 100 });
    }
  }
  return Buffer.from(await doc.save());
}

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

  // Regression coverage for the real incident this addresses (Titleist
  // "Concept V1E", Sept 2026 -- see blank-page-detection.ts's header):
  // every page of that 31-page drawing rendered blank because its
  // embedded images were JPEG2000-encoded and @napi-rs/canvas's PDF.js
  // can't decode that format. A synthetic PDF with a genuinely
  // content-free page reproduces the same "renders successfully, but the
  // canvas has nothing on it" shape without needing a real JPX fixture.
  it("excludes a genuinely blank page mid-document, renumbering images/pageTexts/pageNumbers around it", async () => {
    const bytes = await buildTestPdf(3, [2]);
    const { images, pageTexts, pageNumbers, blankPageNumbers } = await pageImages(PDF_MIME, bytes);

    // Page 2 is dropped entirely -- images/pageNumbers skip straight from
    // page 1 to page 3, not [1, 2] as array position would otherwise imply.
    expect(pageNumbers).toEqual([1, 3]);
    expect(images).toHaveLength(2);
    expect(pageTexts).toHaveLength(2);
    expect(blankPageNumbers).toEqual([2]);
  });

  it("reports totalPages including blank pages, distinct from images.length", async () => {
    const bytes = await buildTestPdf(3, [2]);
    const { totalPages, images } = await pageImages(PDF_MIME, bytes);

    expect(totalPages).toBe(3);
    expect(images).toHaveLength(2);
  });

  it("returns images: [] and every page number in blankPageNumbers when the whole document is blank", async () => {
    const bytes = await buildTestPdf(2, [1, 2]);
    const { images, pageTexts, pageNumbers, blankPageNumbers, totalPages } = await pageImages(PDF_MIME, bytes);

    expect(images).toEqual([]);
    expect(pageTexts).toEqual([]);
    expect(pageNumbers).toEqual([]);
    expect(blankPageNumbers).toEqual([1, 2]);
    expect(totalPages).toBe(2);
  });
});

describe("summarizeDrawing blank-page handling", () => {
  // getDrawingAiClient() constructs the OpenAI client before pageImages()
  // ever runs (throwing AiNotConfiguredError first when no key is set --
  // see the test above), so reaching the blank-page branch needs a key
  // present. A fake one is safe here: this branch returns before any real
  // API call (client.chat.completions.create) is ever made.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("writes UNSUPPORTED with a specific, persisted reason when every page renders blank", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-real-key");
    const bytes = await buildTestPdf(2, [1, 2]);
    const document = await makeDrawingDocument("blank.pdf", PDF_MIME, bytes);

    const result = await summarizeDrawing(document.id);

    expect(result.extractionStatus).toBe("UNSUPPORTED");
    expect(result.analysisError).toMatch(/blank/i);
    expect(result.analysisError).toMatch(/JPEG2000/i);
    expect(result.analysisErrorAt).not.toBeNull();
  });
});

describe("SYSTEM_PROMPT", () => {
  // Real gap this closes (Sept 2026, Titleist "GeneralMeasurements.pdf" --
  // real production use): drawing-line-item-service.ts's own SYSTEM_PROMPT
  // got this exact decimal-inch-notation clarification fixed earlier this
  // session, but this file's separate SYSTEM_PROMPT (the Analyze pass that
  // builds Document.extractedSummary.scopeSummary, the checklist Propose
  // later cross-checks against) never did -- confirmed live: the checklist
  // for a real document showed "236' 8"", "290' 5"", "39' 6"" where the
  // real printed values are 236.80", 290.50", 39.06" (decimal inches
  // misread as feet-and-inches). Propose's own gaps cross-check caught and
  // explained the discrepancy after the fact, but the real fix is here, at
  // the source that produced the bad checklist entry in the first place.
  it("instructs the model to read decimal-inch notation correctly, not as feet-and-inches", () => {
    expect(SYSTEM_PROMPT).toMatch(/decimal-inch notation/);
    expect(SYSTEM_PROMPT).toMatch(/not the X'-Y" feet-and-inches format/);
  });
});
