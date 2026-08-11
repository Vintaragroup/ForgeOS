/*
  Warnings:

  - You are about to drop the column `taxCity` on the `estimates` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "estimates" DROP COLUMN "taxCity",
ADD COLUMN     "taxRateId" TEXT;

-- CreateTable
CREATE TABLE "tax_rates" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "city" TEXT,
    "label" TEXT,
    "rate" DECIMAL(6,4) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "tax_rates_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_taxRateId_fkey" FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
