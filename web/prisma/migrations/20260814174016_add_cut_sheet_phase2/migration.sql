-- CreateTable
CREATE TABLE "cut_sheets" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "sheetNumber" INTEGER NOT NULL,
    "layout" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cut_sheets_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cut_sheets" ADD CONSTRAINT "cut_sheets_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cut_sheets" ADD CONSTRAINT "cut_sheets_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
