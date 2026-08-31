-- CreateEnum
CREATE TYPE "LineItemUsageTag" AS ENUM ('RENTAL_PANEL', 'GRAPHIC');

-- AlterTable
ALTER TABLE "line_items" ADD COLUMN     "usageTag" "LineItemUsageTag";
