-- CreateEnum
CREATE TYPE "VendorExtractionPhase" AS ENUM ('IDLE', 'READING_DOCUMENT', 'EXTRACTING_LINES', 'MATCHING', 'COMPLETE', 'FAILED');

-- AlterTable
ALTER TABLE "bid_packages" ADD COLUMN     "matchResult" JSONB,
ADD COLUMN     "vendorExtractionError" TEXT,
ADD COLUMN     "vendorExtractionPhase" "VendorExtractionPhase" NOT NULL DEFAULT 'IDLE',
ADD COLUMN     "vendorExtractionStartedAt" TIMESTAMP(3);
