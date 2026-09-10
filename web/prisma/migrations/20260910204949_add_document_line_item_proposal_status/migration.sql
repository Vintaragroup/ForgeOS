-- CreateEnum
CREATE TYPE "LineItemProposalStatus" AS ENUM ('IDLE', 'ANALYZING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "lineItemProposalBatchIndex" INTEGER,
ADD COLUMN     "lineItemProposalBatchTotal" INTEGER,
ADD COLUMN     "lineItemProposalError" TEXT,
ADD COLUMN     "lineItemProposalStartedAt" TIMESTAMP(3),
ADD COLUMN     "lineItemProposalStatus" "LineItemProposalStatus" NOT NULL DEFAULT 'IDLE';
