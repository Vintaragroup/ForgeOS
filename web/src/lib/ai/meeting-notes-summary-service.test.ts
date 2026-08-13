import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { uploadDocument } from "@/lib/document-service";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { summarizeMeetingNotes } from "@/lib/ai/meeting-notes-summary-service";
import { TEXT_MIME } from "@/lib/ai/text-extraction";

afterEach(async () => {
  await db.document.deleteMany();
  await db.opportunity.deleteMany();
  await db.company.deleteMany();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeMeetingNotesDocument(text: string) {
  const company = await db.company.create({ data: { name: "Test Co" } });
  const opportunity = await db.opportunity.create({ data: { companyId: company.id, showName: "Test Show" } });
  const file = new File([text], "transcript.txt", { type: TEXT_MIME });
  return uploadDocument(opportunity.id, { file, documentType: "MEETING_NOTES" });
}

describe("summarizeMeetingNotes", () => {
  // OPENAI_API_KEY is deliberately unset in .env.test -- same posture as
  // document-summary-service.test.ts / drawing-summary-service.test.ts:
  // verifies the "AI features not configured" path, not a real call.
  it("throws AiNotConfiguredError before touching the document, leaving it PENDING and retryable", async () => {
    const document = await makeMeetingNotesDocument("Speaker A: Let's discuss the exhibit design.");

    await expect(summarizeMeetingNotes(document.id)).rejects.toBeInstanceOf(AiNotConfiguredError);

    const refreshed = await db.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(refreshed.extractionStatus).toBe("PENDING");
    expect(refreshed.extractedText).toBeNull();
  });

  it("marks an empty transcript UNSUPPORTED without needing an API key", async () => {
    const document = await makeMeetingNotesDocument("   ");

    const result = await summarizeMeetingNotes(document.id);

    expect(result.extractionStatus).toBe("UNSUPPORTED");
    expect(result.extractedText).toBeNull();
  });
});
