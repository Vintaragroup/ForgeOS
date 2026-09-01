// Chat roadmap Phase 3: chunk a document's extractedText, embed each
// chunk, and store the vectors in Postgres via pgvector -- so a chat
// question (chat-context-service.ts) retrieves only the handful of
// chunks actually relevant to it instead of every document's full text
// competing for one fixed character budget. No Prisma-native vector type
// exists, so every read/write of DocumentChunk.embedding goes through
// $queryRaw/$executeRaw, never the generated Client API -- see
// schema.prisma's own comment on that column. Every other column on the
// model (documentId, opportunityId, chunkIndex, content) still goes
// through the normal typed client fine; Unsupported() only blocks the
// one field itself.

import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { EMBEDDING_MODEL, getOpenAiClient } from "@/lib/ai/openai-client";
import { recordAiUsage } from "@/lib/ai/ai-usage-service";

// Character-based, not token-based -- consistent with the rest of this
// app's budget math (chat-context-service.ts's MAX_CONTEXT_CHARS).
// ~1200 chars is comfortably inside text-embedding-3-small's context
// window with huge headroom, and small enough that a retrieved chunk
// reads as one coherent passage rather than a half-page dump.
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;

// Comfortably under the embeddings endpoint's per-request item/token
// caps rather than tuned to the exact limit -- a real document rarely
// produces more than a few dozen chunks anyway.
const EMBED_BATCH_SIZE = 96;

// How many chunks one chat question pulls in, across every indexed
// document on the opportunity at once (not per document) -- generous
// relative to chat-context-service.ts's 150k-char budget: a dozen
// ~1200-char chunks is ~14k chars, leaving plenty of room for line items,
// history, and any not-yet-indexed document still using the old
// full-text fallback. Errs toward more context per answer over a
// tighter, riskier cutoff.
export const RETRIEVAL_TOP_K = 12;

// Splits on the nearest preceding space within a small window of the
// target boundary so a chunk doesn't end mid-word -- falls back to a
// hard cut only for an unbroken run of text longer than that window (a
// long URL or table row, in practice). Overlap keeps a fact that happens
// to sit right at a boundary readable in whichever chunk retrieval picks.
export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    let end = Math.min(start + chunkSize, trimmed.length);
    if (end < trimmed.length) {
      const lastSpace = trimmed.lastIndexOf(" ", end);
      if (lastSpace > start + chunkSize - 100) end = lastSpace;
    }
    const piece = trimmed.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= trimmed.length) break;
    start = end - overlap;
  }
  return chunks;
}

// pgvector's own text input format -- '[0.1,0.2,...]'::vector. Safe to
// interpolate as a normal SQL parameter (not string-built into the query
// text) since every caller passes this through $queryRaw/$executeRaw's
// tagged template, which parameterizes it like any other value.
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(",")}]`;
}

async function embedTexts(
  texts: string[],
  context: { userId: string | null; opportunityId: string; documentId?: string },
): Promise<number[][]> {
  const client = getOpenAiClient();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    const response = await client.embeddings.create({ model: EMBEDDING_MODEL, input: batch });
    await recordAiUsage({
      userId: context.userId,
      feature: "DOCUMENT_EMBEDDING",
      model: EMBEDDING_MODEL,
      usage: response.usage
        ? { prompt_tokens: response.usage.prompt_tokens, completion_tokens: 0, total_tokens: response.usage.total_tokens }
        : undefined,
      documentId: context.documentId,
      opportunityId: context.opportunityId,
    });
    // The API returns embeddings in the same order as the input batch --
    // relied on here to zip each vector back to its source chunk without
    // re-matching on content.
    vectors.push(...response.data.map((d) => d.embedding));
  }
  return vectors;
}

// Re-indexes a document from scratch -- safe to call again on
// re-analysis (deletes any existing chunks first) rather than trying to
// diff old chunks against new text. Caller decides whether a failure
// here should be visible or silently best-effort; this throws rather
// than swallowing anything itself (see document-summary-service.ts's own
// call site for why it treats this as best-effort).
export async function indexDocument(
  documentId: string,
  opportunityId: string,
  text: string,
  userId: string | null = null,
): Promise<void> {
  await db.documentChunk.deleteMany({ where: { documentId } });

  const chunks = chunkText(text);
  if (chunks.length === 0) return;

  const embeddings = await embedTexts(chunks, { userId, opportunityId, documentId });

  const rows = chunks.map(
    (content, i) =>
      Prisma.sql`(${randomUUID()}, ${documentId}, ${opportunityId}, ${i}, ${content}, ${toVectorLiteral(embeddings[i])}::vector)`,
  );
  await db.$executeRaw`
    INSERT INTO document_chunks (id, "documentId", "opportunityId", "chunkIndex", content, embedding)
    VALUES ${Prisma.join(rows)}
  `;
}

// Every document on the Opportunity that has at least one chunk -- lets
// chat-context-service.ts split its document list into "handled by
// retrieval below" vs. "not indexed yet, fall back to the old full-text
// dump" per document, so a document analyzed before this feature existed
// (or one indexing failed for) keeps working exactly as it did before
// this phase, instead of silently going dark.
export async function getIndexedDocumentIds(opportunityId: string): Promise<Set<string>> {
  const rows = await db.documentChunk.findMany({
    where: { opportunityId },
    select: { documentId: true },
    distinct: ["documentId"],
  });
  return new Set(rows.map((r) => r.documentId));
}

export interface RetrievedChunk {
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
}

// Embeds the question once, then a single cosine-distance ORDER BY across
// every indexed chunk on the Opportunity (the HNSW index on
// DocumentChunk.embedding is what keeps this fast as the corpus grows) --
// deliberately opportunity-wide, not per-document, so the top K chunks
// can come from whichever document(s) actually answer the question,
// concentrated or spread across several.
export async function retrieveRelevantChunks(
  opportunityId: string,
  question: string,
  userId: string | null = null,
  topK: number = RETRIEVAL_TOP_K,
): Promise<RetrievedChunk[]> {
  const [queryEmbedding] = await embedTexts([question], { userId, opportunityId });
  const vectorLiteral = toVectorLiteral(queryEmbedding);

  return db.$queryRaw<RetrievedChunk[]>`
    SELECT dc."documentId" AS "documentId", d."filename" AS "filename", dc."chunkIndex" AS "chunkIndex", dc."content" AS "content"
    FROM "document_chunks" dc
    JOIN "documents" d ON d."id" = dc."documentId"
    WHERE dc."opportunityId" = ${opportunityId}
    ORDER BY dc."embedding" <=> ${vectorLiteral}::vector
    LIMIT ${topK}
  `;
}
