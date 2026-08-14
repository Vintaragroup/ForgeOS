-- CreateEnum
CREATE TYPE "MaterialType" AS ENUM ('SHEET', 'LINEAR');

-- AlterTable
ALTER TABLE "materials" ADD COLUMN     "defaultKerf" DECIMAL(6,3),
ADD COLUMN     "grainDirectionMatters" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "materialType" "MaterialType",
ADD COLUMN     "stockLength" DECIMAL(8,3),
ADD COLUMN     "stockWidth" DECIMAL(8,3),
ADD COLUMN     "thickness" DECIMAL(8,3);

-- CreateTable
CREATE TABLE "cut_list_parts" (
    "id" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "width" DECIMAL(8,3),
    "length" DECIMAL(8,3) NOT NULL,
    "thickness" DECIMAL(8,3),
    "grainConstrained" BOOLEAN NOT NULL DEFAULT false,
    "edgeBanding" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "estimateVersionId" TEXT NOT NULL,
    "lineItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "cut_list_parts_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "cut_list_parts" ADD CONSTRAINT "cut_list_parts_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cut_list_parts" ADD CONSTRAINT "cut_list_parts_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cut_list_parts" ADD CONSTRAINT "cut_list_parts_lineItemId_fkey" FOREIGN KEY ("lineItemId") REFERENCES "line_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
