import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { analyzeDocument } from "@/lib/ai/analyze-document";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeOpportunity() {
  const company = await db.company.create({ data: { name: "Test Co" } });
  return db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
}

// Regression test for the cross-resource ID authorization gap -- see
// analyzeDocument's own header comment. The ownership check throws
// before any AI call is ever made, so this doesn't need an OPENAI_API_KEY
// or any AI-client mocking to verify.
describe("analyzeDocument -- opportunity-ownership check", () => {
  it("rejects a documentId that belongs to a different opportunity, without ever reaching the AI call", async () => {
    const owner = await makeOpportunity();
    const attacker = await makeOpportunity();
    const document = await db.document.create({
      data: {
        opportunityId: owner.id,
        filename: "schedule.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
        storageKey: "unused-for-this-test",
        documentType: "SCHEDULE",
      },
    });

    await expect(analyzeDocument(attacker.id, document.id)).rejects.toThrow();

    const stillPending = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(stillPending.extractionStatus).toBe("PENDING");
  });
});
