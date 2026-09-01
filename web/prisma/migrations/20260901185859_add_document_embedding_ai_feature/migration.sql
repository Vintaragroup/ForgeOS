-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'DOCUMENT_EMBEDDING';

-- The DropIndex Prisma generated here for document_chunks_embedding_hnsw_idx
-- is deliberately removed: Prisma's schema language has no way to declare a
-- custom index type (hnsw/vector_cosine_ops), so its diff engine doesn't
-- know that index is supposed to exist and wants to "correct" it away on
-- every future `migrate dev` diff. Keep it -- see the previous migration
-- (20260901185550_add_document_chunks) for why it exists at all.
