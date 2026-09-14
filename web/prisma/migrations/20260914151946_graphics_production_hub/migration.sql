/*
  Warnings:

  - A unique constraint covering the columns `[initials]` on the table `vendors` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PostShowStatus" AS ENUM ('NOT_RECEIVED', 'EXPO_STORAGE', 'SHIP_TO_CLIENT', 'DISCARDED');

-- CreateEnum
CREATE TYPE "PostShowCondition" AS ENUM ('OK_TO_REUSE', 'DAMAGED', 'DIRTY', 'PRODUCT');

-- CreateEnum
CREATE TYPE "ExistingGraphicsStatus" AS ENUM ('NEW_IMAGE', 'EXISTING', 'DAMAGED', 'NOT_EXISTING');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ArtworkOrderStatus" ADD VALUE 'RECEIVED_FROM_VENDOR';
ALTER TYPE "ArtworkOrderStatus" ADD VALUE 'INSPECTED';
ALTER TYPE "ArtworkOrderStatus" ADD VALUE 'REPRINT_REQUESTED';
ALTER TYPE "ArtworkOrderStatus" ADD VALUE 'CANCELLED';

-- DropForeignKey
ALTER TABLE "artwork_orders" DROP CONSTRAINT "artwork_orders_opportunityId_fkey";

-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "artDueDate" TIMESTAMP(3),
ADD COLUMN     "designerId" TEXT,
ADD COLUMN     "existingGraphicsStatus" "ExistingGraphicsStatus",
ADD COLUMN     "finishingDetails" TEXT,
ADD COLUMN     "graphicCode" TEXT,
ADD COLUMN     "postShowCondition" "PostShowCondition",
ADD COLUMN     "postShowRecordedAt" TIMESTAMP(3),
ADD COLUMN     "postShowRecordedByUserId" TEXT,
ADD COLUMN     "postShowStatus" "PostShowStatus",
ADD COLUMN     "showId" TEXT,
ADD COLUMN     "verifiedSizes" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "opportunityId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "initials" TEXT;

-- CreateIndex
CREATE INDEX "artwork_orders_showId_idx" ON "artwork_orders"("showId");

-- CreateIndex
CREATE INDEX "artwork_orders_designerId_idx" ON "artwork_orders"("designerId");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_initials_key" ON "vendors"("initials");

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_showId_fkey" FOREIGN KEY ("showId") REFERENCES "shows"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_designerId_fkey" FOREIGN KEY ("designerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
