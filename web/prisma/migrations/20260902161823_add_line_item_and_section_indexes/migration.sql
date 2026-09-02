-- CreateIndex
CREATE INDEX "estimate_sections_estimateVersionId_idx" ON "estimate_sections"("estimateVersionId");

-- CreateIndex
CREATE INDEX "estimate_sections_optionId_idx" ON "estimate_sections"("optionId");

-- CreateIndex
CREATE INDEX "line_items_sectionId_idx" ON "line_items"("sectionId");

-- CreateIndex
CREATE INDEX "line_items_bidPackageId_idx" ON "line_items"("bidPackageId");

-- CreateIndex
CREATE INDEX "line_items_documentId_idx" ON "line_items"("documentId");

-- CreateIndex
CREATE INDEX "line_items_attachmentId_idx" ON "line_items"("attachmentId");
