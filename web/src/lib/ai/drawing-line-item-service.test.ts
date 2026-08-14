import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { proposeLineItemsFromDrawing } from "@/lib/ai/drawing-line-item-service";
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

    await expect(proposeLineItemsFromDrawing(document.id)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const refreshed = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(refreshed.proposedLineItems).toBeNull();
  });
});
