-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'SECTION_DESCRIPTION';

-- AlterTable
ALTER TABLE "estimate_sections" ADD COLUMN     "description" TEXT,
ADD COLUMN     "pendingDescription" TEXT;
