-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "rolledOverFromId" TEXT;

-- CreateIndex
CREATE INDEX "artwork_orders_rolledOverFromId_idx" ON "artwork_orders"("rolledOverFromId");

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_rolledOverFromId_fkey" FOREIGN KEY ("rolledOverFromId") REFERENCES "artwork_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
