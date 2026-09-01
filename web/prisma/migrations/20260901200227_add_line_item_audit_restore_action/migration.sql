-- AlterEnum
ALTER TYPE "LineItemAuditAction" ADD VALUE 'RESTORE';

-- The DropIndex Prisma generated here for document_chunks_embedding_hnsw_idx
-- is deliberately removed -- same reason as the previous migration that hit
-- this (20260901185859_add_document_embedding_ai_feature): Prisma's schema
-- language has no way to declare a custom index type (hnsw/vector_cosine_ops),
-- so its diff engine doesn't know that index is supposed to exist.
