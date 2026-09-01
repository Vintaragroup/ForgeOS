-- CreateExtension
-- Render Postgres (production) and local Homebrew Postgres (dev/test, see
-- CLAUDE.md/session notes on chat Phase 3) both support this. Hand-added --
-- `prisma migrate dev` has no notion of Postgres extensions, only ever
-- generates the CREATE TABLE below from the schema's `Unsupported("vector(1536)")`.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "document_chunks" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_chunks_documentId_idx" ON "document_chunks"("documentId");

-- CreateIndex
CREATE INDEX "document_chunks_opportunityId_idx" ON "document_chunks"("opportunityId");

-- AddForeignKey
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- HNSW, not IVFFlat -- no training step needed (IVFFlat's lists need to be
-- built against existing data to be any good, awkward on a table that
-- starts empty and grows one document at a time) and better recall at this
-- corpus's likely scale (a few thousand chunks per opportunity at most, not
-- millions). vector_cosine_ops to match the `<=>` cosine-distance operator
-- document-embedding-service.ts's retrieval query uses.
CREATE INDEX "document_chunks_embedding_hnsw_idx" ON "document_chunks" USING hnsw ("embedding" vector_cosine_ops);
