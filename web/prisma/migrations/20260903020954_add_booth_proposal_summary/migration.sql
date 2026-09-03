-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'BOOTH_PROPOSAL_SUMMARY';

-- AlterTable
ALTER TABLE "estimate_sections" ADD COLUMN     "boothPendingSummary" TEXT,
ADD COLUMN     "boothSummary" TEXT;
