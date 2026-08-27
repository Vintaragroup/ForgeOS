import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { proposeVendorQuoteLineItems } from "@/lib/ai/vendor-quote-service";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

// Same fixture shape as scope-line-item-service.test.ts's
// makeAnalyzedDocument -- a real vendor quote is a PDF, but nothing this
// module does needs real bytes off disk (unlike commitScopeLineItems's
// page-number lookup), so a fake storageKey is fine here too.
async function makeAnalyzedDocument(extractedText: string | null) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  return db.document.create({
    data: {
      opportunityId: opportunity.id,
      filename: "ShowRig quote.pdf",
      mimeType: "application/pdf",
      sizeBytes: 100,
      storageKey: "test-key",
      documentType: "VENDOR_QUOTE",
      extractionStatus: extractedText ? "COMPLETE" : "PENDING",
      extractedText,
    },
  });
}

describe("proposeVendorQuoteLineItems", () => {
  it("refuses to propose prices for a document that hasn't been analyzed yet, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument(null);

    await expect(proposeVendorQuoteLineItems(document.id, document.opportunityId)).rejects.toThrow(
      /hasn't been analyzed yet/,
    );
  });

  it("throws AiNotConfiguredError for an analyzed document when no API key is set -- .env.test deliberately has none", async () => {
    const document = await makeAnalyzedDocument("CAM-06 Sleeper Floor $840.00");

    await expect(proposeVendorQuoteLineItems(document.id, document.opportunityId)).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });

  // Regression-shaped test for the cross-resource ID authorization gap
  // every other AI-proposal function in this app is guarded against --
  // see the function's own header comment.
  it("rejects a documentId that belongs to a different opportunity, before ever touching the OpenAI client", async () => {
    const document = await makeAnalyzedDocument("CAM-06 Sleeper Floor $840.00");
    const otherCompany = await db.company.create({ data: { name: "Other Co" } });
    const otherOpportunity = await db.opportunity.create({ data: { companyId: otherCompany.id, showName: "Other Show" } });

    await expect(proposeVendorQuoteLineItems(document.id, otherOpportunity.id)).rejects.toThrow();
  });
});
