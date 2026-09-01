import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { AiNotConfiguredError } from "@/lib/ai/openai-client";
import { chunkText, getIndexedDocumentIds, indexDocument, retrieveRelevantChunks } from "@/lib/ai/document-embedding-service";

afterEach(async () => {
  await db.documentChunk.deleteMany();
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

describe("chunkText", () => {
  it("returns nothing for empty or whitespace-only text", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  it("returns the whole text as one chunk when it's already within the chunk size", () => {
    expect(chunkText("A short document.", 1200, 150)).toEqual(["A short document."]);
  });

  it("splits long text into overlapping chunks, breaking on whitespace rather than mid-word", () => {
    // 300 words of "word0 word1 ..." -- long enough to force multiple
    // chunks at a small chunkSize, short words throughout so a boundary
    // reliably lands on a space rather than needing the hard-cut fallback.
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const text = words.join(" ");

    const chunks = chunkText(text, 100, 20);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // Never starts or ends mid-word (a real word boundary, not a
      // fragment like "w4" cut from "w42").
      expect(chunk.trim()).toBe(chunk);
      expect(/^w\d+( w\d+)*$/.test(chunk)).toBe(true);
    }
    // Every word from the source text still appears somewhere across the
    // chunk set -- overlap means some appear twice, none should vanish.
    const allWords = new Set(chunks.join(" ").split(" "));
    for (const w of words) expect(allWords.has(w)).toBe(true);
  });

  it("hard-cuts a single unbroken run of text longer than the chunk size", () => {
    const chunks = chunkText("x".repeat(250), 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });
});

describe("getIndexedDocumentIds", () => {
  it("returns only distinct document ids that actually have chunks", async () => {
    const opportunity = await makeOpportunity();
    const indexed = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "indexed.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "x",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
      },
    });
    await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "not-indexed.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "y",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
      },
    });
    // Inserted directly -- indexDocument itself needs a real OpenAI call
    // (see the "throws" tests below), irrelevant to what this function
    // reads back.
    await db.$executeRaw`
      INSERT INTO document_chunks (id, "documentId", "opportunityId", "chunkIndex", content, embedding)
      VALUES (${"chunk1"}, ${indexed.id}, ${opportunity.id}, ${0}, ${"some text"}, ${"[" + "0,".repeat(1535) + "0]"}::vector)
    `;

    const result = await getIndexedDocumentIds(opportunity.id);

    expect(result).toEqual(new Set([indexed.id]));
  });

  it("returns an empty set when nothing has been indexed", async () => {
    const opportunity = await makeOpportunity();
    expect(await getIndexedDocumentIds(opportunity.id)).toEqual(new Set());
  });
});

// OPENAI_API_KEY is deliberately unset in .env.test (same posture as
// chat-service.test.ts/document-summary-service.test.ts) -- these verify
// the config-guard and the empty-input short-circuit, not a real
// embedding call.
describe("indexDocument", () => {
  it("does nothing and never touches OpenAI for empty text", async () => {
    const opportunity = await makeOpportunity();
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "empty.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "x",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
      },
    });

    await expect(indexDocument(document.id, opportunity.id, "   ")).resolves.toBeUndefined();
    expect(await getIndexedDocumentIds(opportunity.id)).toEqual(new Set());
  });

  it("throws AiNotConfiguredError for real text, without leaving stale chunks behind", async () => {
    const opportunity = await makeOpportunity();
    const document = await db.document.create({
      data: {
        opportunityId: opportunity.id,
        filename: "real.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "x",
        documentType: "RFP",
        extractionStatus: "COMPLETE",
      },
    });

    await expect(indexDocument(document.id, opportunity.id, "Real document content to embed.")).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
    expect(await getIndexedDocumentIds(opportunity.id)).toEqual(new Set());
  });
});

describe("retrieveRelevantChunks", () => {
  it("throws AiNotConfiguredError before querying the database", async () => {
    const opportunity = await makeOpportunity();
    await expect(retrieveRelevantChunks(opportunity.id, "What's the booth size?")).rejects.toBeInstanceOf(
      AiNotConfiguredError,
    );
  });
});
