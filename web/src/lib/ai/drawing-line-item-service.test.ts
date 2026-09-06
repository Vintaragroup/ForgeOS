import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { proposeLineItemsFromDrawing, SYSTEM_PROMPT } from "@/lib/ai/drawing-line-item-service";
import { PDF_MIME } from "@/lib/ai/text-extraction";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeDrawingDocument() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));
  const file = new File([new Uint8Array(bytes)], "drawing.pdf", { type: PDF_MIME });
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
