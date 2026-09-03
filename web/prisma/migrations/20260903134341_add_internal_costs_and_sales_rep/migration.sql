-- CreateEnum
CREATE TYPE "InternalCostCategory" AS ENUM ('OVERHEAD', 'PROJECT_RELATED', 'OTHER');

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "anticipatedFeePct" DECIMAL(5,2),
ADD COLUMN     "contractedFeePct" DECIMAL(5,2),
ADD COLUMN     "salesRepId" TEXT;

-- CreateTable
CREATE TABLE "internal_costs" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "sectionId" TEXT,
    "category" "InternalCostCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "internal_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "internal_costs_estimateVersionId_idx" ON "internal_costs"("estimateVersionId");

-- CreateIndex
CREATE INDEX "internal_costs_sectionId_idx" ON "internal_costs"("sectionId");

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_salesRepId_fkey" FOREIGN KEY ("salesRepId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_costs" ADD CONSTRAINT "internal_costs_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_costs" ADD CONSTRAINT "internal_costs_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "estimate_sections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
