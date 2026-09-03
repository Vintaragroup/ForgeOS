-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiFeature" ADD VALUE 'ELEMENT_PROPOSAL_SUMMARY';
ALTER TYPE "AiFeature" ADD VALUE 'CATEGORY_PROPOSAL_SUMMARY';

-- AlterTable
ALTER TABLE "estimate_sections" ADD COLUMN     "elementPendingSummary" TEXT,
ADD COLUMN     "elementSummary" TEXT;

-- CreateTable
CREATE TABLE "estimate_category_summaries" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "summary" TEXT,
    "pendingSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_category_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "estimate_category_summaries_estimateVersionId_categoryId_key" ON "estimate_category_summaries"("estimateVersionId", "categoryId");

-- AddForeignKey
ALTER TABLE "estimate_category_summaries" ADD CONSTRAINT "estimate_category_summaries_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_category_summaries" ADD CONSTRAINT "estimate_category_summaries_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
