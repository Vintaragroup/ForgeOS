-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "aiProposalSnapshot" JSONB;

-- CreateTable
CREATE TABLE "line_item_accuracy_flags" (
    "id" TEXT NOT NULL,
    "lineItemId" TEXT,
    "estimateVersionId" TEXT NOT NULL,
    "aiFeature" "AiFeature" NOT NULL,
    "originalProposal" JSONB NOT NULL,
    "correctedValues" JSONB NOT NULL,
    "reason" TEXT,
    "flaggedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "line_item_accuracy_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "line_item_accuracy_flags_estimateVersionId_createdAt_idx" ON "line_item_accuracy_flags"("estimateVersionId", "createdAt");

-- AddForeignKey
ALTER TABLE "line_item_accuracy_flags" ADD CONSTRAINT "line_item_accuracy_flags_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_item_accuracy_flags" ADD CONSTRAINT "line_item_accuracy_flags_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
