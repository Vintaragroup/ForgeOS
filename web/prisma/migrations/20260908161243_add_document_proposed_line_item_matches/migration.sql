-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'LINE_ITEM_DUPLICATE_MATCH';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "proposedLineItemMatches" JSONB;
