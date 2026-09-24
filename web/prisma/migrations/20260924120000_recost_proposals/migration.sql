-- One proposed change to an estimate, from a re-cost review.
-- See docs/recost-review.md. Expand-only: new enums, new table, new
-- indexes. Nothing existing is altered, so this is safe to apply ahead
-- of the code that writes it.

CREATE TYPE "RecostAction" AS ENUM ('REMOVE', 'REDUCE_QTY', 'REPRICE', 'ADD', 'NEEDS_QUOTE');
CREATE TYPE "RecostConfidence" AS ENUM ('RECOMMEND_AND_CONFIRM', 'NEED_YOUR_DECISION');
CREATE TYPE "RecostStatus" AS ENUM ('PROPOSED', 'ACCEPTED', 'REJECTED', 'APPLIED');

CREATE TABLE "recost_proposals" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "proposalId" TEXT,
    "lineItemId" TEXT,
    "sectionId" TEXT,
    "action" "RecostAction" NOT NULL,
    "newQty" DECIMAL(12,2),
    "newUnitCost" DECIMAL(12,2),
    "reason" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "sourceQuote" TEXT NOT NULL,
    "sourceLocation" TEXT,
    "confidence" "RecostConfidence" NOT NULL,
    "status" "RecostStatus" NOT NULL DEFAULT 'PROPOSED',
    "dependsOnId" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recost_proposals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recost_proposals_estimateVersionId_status_idx" ON "recost_proposals"("estimateVersionId", "status");

ALTER TABLE "recost_proposals" ADD CONSTRAINT "recost_proposals_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recost_proposals" ADD CONSTRAINT "recost_proposals_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recost_proposals" ADD CONSTRAINT "recost_proposals_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "estimate_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recost_proposals" ADD CONSTRAINT "recost_proposals_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recost_proposals" ADD CONSTRAINT "recost_proposals_dependsOnId_fkey" FOREIGN KEY ("dependsOnId") REFERENCES "recost_proposals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "recost_proposals" ADD CONSTRAINT "recost_proposals_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
