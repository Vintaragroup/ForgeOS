-- CreateEnum
CREATE TYPE "ArtworkProductionStatus" AS ENUM ('NOT_STARTED', 'PRINTING', 'COMPLETED', 'OS_NOT_SENT', 'OS_SENT', 'OS_QUOTE_APPROVED', 'OS_PROOF_APPROVED', 'OS_RECEIVED', 'OS_RECEIVED_PARTIALLY', 'OS_DELIVERED_TO_SHOWSITE', 'CANCELLED');

-- AlterTable
ALTER TABLE "artwork_order_routings" ADD COLUMN     "productionStatus" "ArtworkProductionStatus" NOT NULL DEFAULT 'NOT_STARTED';


-- The 625 backfilled routings are all VENDOR halves on archived history,
-- so NOT_STARTED (the column default) would claim work that finished last
-- January has not begun. Seed them from the order's own status instead:
-- anything that reached packing or beyond came back from the vendor.
UPDATE "artwork_order_routings" r
   SET "productionStatus" = 'OS_RECEIVED'
  FROM "artwork_orders" a
 WHERE a."id" = r."artworkOrderId"
   AND r."kind" = 'VENDOR'
   AND a."status" IN ('RECEIVED_FROM_VENDOR','INSPECTED','PACKAGED_READY','SHIPPED_TO_SHOW','DELIVERED_AT_SHOW');

UPDATE "artwork_order_routings" r
   SET "productionStatus" = 'CANCELLED'
  FROM "artwork_orders" a
 WHERE a."id" = r."artworkOrderId" AND a."status" = 'CANCELLED';

-- Still with the vendor when the import froze it.
UPDATE "artwork_order_routings" r
   SET "productionStatus" = 'OS_SENT'
  FROM "artwork_orders" a
 WHERE a."id" = r."artworkOrderId"
   AND r."kind" = 'VENDOR'
   AND a."status" IN ('IN_PRODUCTION','PRODUCTION_GO_AHEAD');
