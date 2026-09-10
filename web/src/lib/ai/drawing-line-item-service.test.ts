import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { proposeLineItemsFromDrawing, SYSTEM_PROMPT } from "@/lib/ai/drawing-line-item-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

// Same fixture-builder pattern as drawing-summary-service.test.ts -- a
// deterministic, content-free PDF page reproduces the real "renders
// successfully but the canvas has nothing on it" shape (see
// blank-page-detection.ts's header for the real JPEG2000-decode incident
// this covers) without needing a real JPX fixture file.
async function buildBlankPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) doc.addPage([200, 200]); // no drawn content -- genuinely blank
  return Buffer.from(await doc.save());
}

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeDrawingDocument(bytes?: Buffer) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const pdfBytes = bytes ?? (await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf")));
  const file = new File([new Uint8Array(pdfBytes)], "drawing.pdf", { type: PDF_MIME });
  return uploadDocument(opportunity.id, { file, documentType: "DRAWING" });
}

describe("proposeLineItemsFromDrawing", () => {
  // OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
  // drawing-summary-service.test.ts's summarizeDrawing test: this proves
  // the "AI features not configured" path, checked before pageImages is
  // even called (same order as summarizeDrawing), not a real vision call
  // (that needs a real key, tested manually per this feature's own plan).
  it("throws AiNotConfiguredError before writing anything to the document", async () => {
    const document = await makeDrawingDocument();

    await expect(proposeLineItemsFromDrawing(document.id, document.opportunityId)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const refreshed = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(refreshed.proposedLineItems).toBeNull();
  });

  // Regression test for the cross-resource ID authorization gap: this
  // previously trusted documentId alone -- see the function's own header
  // comment.
  it("rejects a documentId that belongs to a different opportunity, before ever touching the OpenAI client", async () => {
    const document = await makeDrawingDocument();
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(proposeLineItemsFromDrawing(document.id, otherOpportunity.id)).rejects.toThrow(
      "This document doesn't belong to this opportunity.",
    );
  });
});

describe("proposeLineItemsFromDrawing blank-page handling", () => {
  // getDrawingAiClient() runs before pageImages() here too (same order as
  // summarizeDrawing), so reaching the all-blank branch needs a key
  // present -- a fake one is safe since that branch returns before any
  // real API call.
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("caches an empty proposal, not an error, when every page renders blank", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-real-key");
    const bytes = await buildBlankPdf(2);
    const document = await makeDrawingDocument(bytes);

    const result = await proposeLineItemsFromDrawing(document.id, document.opportunityId);

    expect(result.proposedLineItems).toEqual([]);
  });
});

describe("SYSTEM_PROMPT", () => {
  // Same fix as scope-line-item-service.ts's buildSystemPrompt, applied
  // here too -- a drawing has no text layer to verify a sourceQuote
  // against (sourceQuote stays "" for every drawing-sourced item, see
  // proposeLineItemsFromDrawing's own comment), which makes getting the
  // description itself right even more important for this path than the
  // text-based one. Only proves the instruction is present, not that the
  // model follows it -- that needs a real key and a real drawing.
  it("instructs the model to preserve source wording for custom-fabricated items", () => {
    expect(SYSTEM_PROMPT).toMatch(/preserve the sheet's own specifying language/);
    expect(SYSTEM_PROMPT).toMatch(/single-sided Chinese birch/);
  });
});
