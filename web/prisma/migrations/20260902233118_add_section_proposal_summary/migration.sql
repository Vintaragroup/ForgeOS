-- DropIndex
DROP INDEX "document_chunks_embedding_hnsw_idx";

-- AlterTable
ALTER TABLE "estimate_sections" ADD COLUMN     "summarizeOnProposal" BOOLEAN NOT NULL DEFAULT false;
