-- AlterTable
ALTER TABLE "estimate_sections" ADD COLUMN     "includeInProposal" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "proposalSortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "includeInProposal" BOOLEAN NOT NULL DEFAULT true;
