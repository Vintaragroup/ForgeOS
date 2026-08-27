-- CreateEnum
CREATE TYPE "BidPackageStatus" AS ENUM ('AWAITING_QUOTE', 'QUOTE_RECEIVED', 'REVIEWED');

-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'VENDOR_QUOTE_LINE_ITEMS';

-- AlterEnum
ALTER TYPE "DocumentType" ADD VALUE 'VENDOR_QUOTE';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "bidPackageId" TEXT,
ADD COLUMN     "vendorQuoteLineItems" JSONB;

-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "bidPackageId" TEXT;

-- CreateTable
CREATE TABLE "bid_packages" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "vendorName" TEXT,
    "status" "BidPackageStatus" NOT NULL DEFAULT 'AWAITING_QUOTE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "bid_packages_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_bidPackageId_fkey" FOREIGN KEY ("bidPackageId") REFERENCES "bid_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_bidPackageId_fkey" FOREIGN KEY ("bidPackageId") REFERENCES "bid_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_packages" ADD CONSTRAINT "bid_packages_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
