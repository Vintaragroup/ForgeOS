-- CreateEnum
CREATE TYPE "ArtworkRoutingKind" AS ENUM ('EXPO_IN_HOUSE', 'VENDOR', 'AM_PM_COORDINATED');

-- CreateTable
CREATE TABLE "artwork_order_routings" (
    "id" TEXT NOT NULL,
    "artworkOrderId" TEXT NOT NULL,
    "kind" "ArtworkRoutingKind" NOT NULL,
    "vendorId" TEXT,
    "officeCode" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_order_routings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artwork_order_routings_artworkOrderId_idx" ON "artwork_order_routings"("artworkOrderId");

-- CreateIndex
CREATE INDEX "artwork_order_routings_vendorId_idx" ON "artwork_order_routings"("vendorId");

-- AddForeignKey
ALTER TABLE "artwork_order_routings" ADD CONSTRAINT "artwork_order_routings_artworkOrderId_fkey" FOREIGN KEY ("artworkOrderId") REFERENCES "artwork_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_order_routings" ADD CONSTRAINT "artwork_order_routings_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_order_routings" ADD CONSTRAINT "artwork_order_routings_officeCode_fkey" FOREIGN KEY ("officeCode") REFERENCES "offices"("code") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: every piece that already names a vendor gets the equivalent
-- routing row, so `routings` is the complete picture from the moment it
-- exists rather than only for pieces touched after this deploy.
-- ArtworkOrder.vendorId stays as-is -- assignVendor keeps both in step
-- until the column is dropped.
INSERT INTO "artwork_order_routings" ("id", "artworkOrderId", "kind", "vendorId", "createdAt")
SELECT gen_random_uuid()::text, "id", 'VENDOR', "vendorId", now()
  FROM "artwork_orders"
 WHERE "vendorId" IS NOT NULL AND "deletedAt" IS NULL;
