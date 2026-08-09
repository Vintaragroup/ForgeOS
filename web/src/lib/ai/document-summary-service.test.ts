import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { summarizeDocument } from "@/lib/ai/document-summary-service";

const RFP_DIR = path.resolve(import.meta.dirname, "../../../../data/RFP/superbowl/RFP006 - Temporary Booth Build");

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeDocument(documentType: "RFP" | "DRAWING" | "PRICING_SCHEDULE") {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const bytes = await readFile(path.join(RFP_DIR, "1. SBLXI - Temporary Booth Build RFP Final.pdf"));
  const file = new File([bytes], "RFP.pdf", { type: "application/pdf" });
  return uploadDocument(opportunity.id, { file, documentType });
}

describe("summarizeDocument", () => {
  // OPENAI_API_KEY is deliberately unset in .env.test -- this suite
  // verifies the "AI features not configured" path renders correctly,
  // not the real OpenAI call itself (that needs a real key, tested
  // manually per the Phase 7 plan's own posture on vendor-gated tests).
  it("throws AiNotConfiguredError before touching the document, leaving it PENDING and retryable", async () => {
    const document = await makeDocument("RFP");

    await expect(summarizeDocument(document.id)).rejects.toBeInstanceOf(AiNotConfiguredError);

    // Checked before any DB write (see summarizeDocument's own comment) --
    // a config error must not strand the document at PROCESSING with no
    // Analyze button left to retry once a key is added.
    const refreshed = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(refreshed.extractionStatus).toBe("PENDING");
    expect(refreshed.extractedText).toBeNull();
  });

  // analyze-document.ts's dispatcher now routes DRAWING documents to
  // drawing-summary-service.ts's vision-based summarizeDrawing() instead
  // -- this only guards the defensive fallback if summarizeDocument (the
  // text path) is ever called on one directly by mistake; it should
  // still refuse rather than burn a token budget on unextractable text.
  it("marks a DRAWING document UNSUPPORTED if called directly, without ever needing an API key", async () => {
    const document = await makeDocument("DRAWING");

    const result = await summarizeDocument(document.id);

    expect(result.extractionStatus).toBe("UNSUPPORTED");
    expect(result.extractedText).toBeNull();
  });

  it("marks a PRICING_SCHEDULE document UNSUPPORTED -- parsed by pricing-import-service instead", async () => {
    const document = await makeDocument("PRICING_SCHEDULE");

    const result = await summarizeDocument(document.id);

    expect(result.extractionStatus).toBe("UNSUPPORTED");
  });
});
