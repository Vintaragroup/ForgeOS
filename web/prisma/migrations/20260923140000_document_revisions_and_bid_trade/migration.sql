-- Two additions, both expand-only and both nullable, so nothing that
-- exists today changes meaning.
--
-- documents.supersedesId -- the document this one replaces. A
-- RELATIONSHIP rather than a typed "V2" label, so the label is derived
-- instead of maintained: the version number is the depth of the chain,
-- the current document is the one nothing supersedes, and the pair to
-- diff is a document and its predecessor. ON DELETE SET NULL, because
-- losing the predecessor should break the chain, not delete its
-- successor.
--
-- bid_packages.tradeCode / vendorId -- which trade a package is for, and
-- which real vendor quoted it. vendorName stays: it is free text that
-- cannot join to anything, which is why a package could name a shop and
-- still tell you nothing about it, and the packages that only ever had a
-- typed name keep it.

-- AlterTable
ALTER TABLE "bid_packages" ADD COLUMN     "tradeCode" TEXT,
ADD COLUMN     "vendorId" TEXT;

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "supersedesId" TEXT;

-- CreateIndex
CREATE INDEX "documents_supersedesId_idx" ON "documents"("supersedesId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_packages" ADD CONSTRAINT "bid_packages_tradeCode_fkey" FOREIGN KEY ("tradeCode") REFERENCES "departments"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bid_packages" ADD CONSTRAINT "bid_packages_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
