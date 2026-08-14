-- AlterTable
ALTER TABLE "cut_sheets" ADD COLUMN     "consumedRemnantId" TEXT;

-- CreateTable
CREATE TABLE "material_remnants" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "width" DECIMAL(8,3) NOT NULL,
    "length" DECIMAL(8,3) NOT NULL,
    "generatedByCutSheetId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_remnants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "material_remnants_generatedByCutSheetId_key" ON "material_remnants"("generatedByCutSheetId");

-- CreateIndex
CREATE UNIQUE INDEX "cut_sheets_consumedRemnantId_key" ON "cut_sheets"("consumedRemnantId");

-- AddForeignKey
ALTER TABLE "cut_sheets" ADD CONSTRAINT "cut_sheets_consumedRemnantId_fkey" FOREIGN KEY ("consumedRemnantId") REFERENCES "material_remnants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_remnants" ADD CONSTRAINT "material_remnants_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_remnants" ADD CONSTRAINT "material_remnants_generatedByCutSheetId_fkey" FOREIGN KEY ("generatedByCutSheetId") REFERENCES "cut_sheets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
