-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "artwork_orders_archivedAt_idx" ON "artwork_orders"("archivedAt");

