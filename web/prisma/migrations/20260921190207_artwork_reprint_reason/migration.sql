-- CreateEnum
CREATE TYPE "ArtworkReprintReason" AS ENUM ('PRODUCTION_QUALITY', 'TRANSPORT_HANDLING_DAMAGE', 'INSTALL_SITE_DAMAGE', 'CLIENT_CHANGES', 'NEW_ORDER_UPSELL', 'OTHER');

-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "reprintNote" TEXT,
ADD COLUMN     "reprintReason" "ArtworkReprintReason";

