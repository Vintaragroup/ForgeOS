-- CreateTable
CREATE TABLE "vendor_match_apply_logs" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "bidPackageId" TEXT,
    "bidPackageName" TEXT NOT NULL,
    "lineItemId" TEXT,
    "targetDescription" TEXT NOT NULL,
    "targetSectionLabel" TEXT,
    "vendorLineDescriptions" TEXT NOT NULL,
    "vendorLineCount" INTEGER NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "unitCost" DECIMAL(10,2) NOT NULL,
    "totalCost" DECIMAL(12,2) NOT NULL,
    "confidence" TEXT,
    "documentId" TEXT,
    "documentFilename" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_match_apply_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_match_apply_logs_estimateVersionId_idx" ON "vendor_match_apply_logs"("estimateVersionId");

-- CreateIndex
CREATE INDEX "vendor_match_apply_logs_bidPackageId_idx" ON "vendor_match_apply_logs"("bidPackageId");

-- CreateIndex
CREATE INDEX "vendor_match_apply_logs_createdAt_idx" ON "vendor_match_apply_logs"("createdAt");

-- AddForeignKey
ALTER TABLE "vendor_match_apply_logs" ADD CONSTRAINT "vendor_match_apply_logs_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_match_apply_logs" ADD CONSTRAINT "vendor_match_apply_logs_bidPackageId_fkey" FOREIGN KEY ("bidPackageId") REFERENCES "bid_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_match_apply_logs" ADD CONSTRAINT "vendor_match_apply_logs_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_match_apply_logs" ADD CONSTRAINT "vendor_match_apply_logs_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_match_apply_logs" ADD CONSTRAINT "vendor_match_apply_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
