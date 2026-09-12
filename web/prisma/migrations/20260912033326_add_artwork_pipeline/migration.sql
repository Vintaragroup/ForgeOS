-- CreateEnum
CREATE TYPE "ArtworkOrderStatus" AS ENUM ('INVITED', 'ORDER_DRAFTED', 'SUBMITTED', 'UNDER_ART_REVIEW', 'REJECTED', 'ACCEPTED', 'VENDOR_ASSIGNED', 'PROOF_IN_PROGRESS', 'PROOF_SUBMITTED', 'EXPO_PROOF_CHECK', 'PROOF_REVISION_REQUESTED', 'ESCALATED', 'PROOF_UNDER_REVIEW', 'PROOF_APPROVED', 'PRODUCTION_GO_AHEAD', 'IN_PRODUCTION', 'PACKAGED_READY', 'SHIPPED_TO_SHOW', 'DELIVERED_AT_SHOW');

-- CreateEnum
CREATE TYPE "ArtworkActorType" AS ENUM ('CLIENT', 'EXPO', 'VENDOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "ArtworkFileKind" AS ENUM ('CLIENT_ARTWORK', 'PROOF');

-- CreateEnum
CREATE TYPE "ArtworkPortalRole" AS ENUM ('CLIENT', 'VENDOR');

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "email" TEXT;

-- CreateTable
CREATE TABLE "artwork_size_tiers" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "width" DECIMAL(8,3),
    "height" DECIMAL(8,3),
    "isStandard" BOOLEAN NOT NULL DEFAULT true,
    "expoProducedFee" DECIMAL(10,2) NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "artwork_size_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork_orders" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "status" "ArtworkOrderStatus" NOT NULL DEFAULT 'INVITED',
    "sizeTierId" TEXT,
    "customSizeRequested" BOOLEAN NOT NULL DEFAULT false,
    "customWidth" DECIMAL(8,3),
    "customHeight" DECIMAL(8,3),
    "customQuoteAmount" DECIMAL(10,2),
    "customQuoteAcceptedAt" TIMESTAMP(3),
    "material" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "wantsExpoProducedArt" BOOLEAN NOT NULL DEFAULT false,
    "expoProducedFee" DECIMAL(10,2),
    "vendorId" TEXT,
    "jobCode" TEXT NOT NULL,
    "revisionRound" INTEGER NOT NULL DEFAULT 0,
    "slaDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "artwork_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork_files" (
    "id" TEXT NOT NULL,
    "artworkOrderId" TEXT NOT NULL,
    "kind" "ArtworkFileKind" NOT NULL,
    "round" INTEGER NOT NULL DEFAULT 0,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedByType" "ArtworkActorType" NOT NULL,
    "uploadedByUserId" TEXT,
    "uploadedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "artwork_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork_order_events" (
    "id" TEXT NOT NULL,
    "artworkOrderId" TEXT NOT NULL,
    "fromStatus" "ArtworkOrderStatus",
    "toStatus" "ArtworkOrderStatus" NOT NULL,
    "action" TEXT NOT NULL,
    "note" TEXT,
    "detail" JSONB,
    "actorType" "ArtworkActorType" NOT NULL,
    "actorUserId" TEXT,
    "actorEmail" TEXT,
    "restrictedToInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_order_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork_portal_invites" (
    "id" TEXT NOT NULL,
    "artworkOrderId" TEXT NOT NULL,
    "role" "ArtworkPortalRole" NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_portal_invites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "artwork_orders_jobCode_key" ON "artwork_orders"("jobCode");

-- CreateIndex
CREATE INDEX "artwork_orders_opportunityId_idx" ON "artwork_orders"("opportunityId");

-- CreateIndex
CREATE INDEX "artwork_orders_vendorId_idx" ON "artwork_orders"("vendorId");

-- CreateIndex
CREATE INDEX "artwork_files_artworkOrderId_idx" ON "artwork_files"("artworkOrderId");

-- CreateIndex
CREATE INDEX "artwork_order_events_artworkOrderId_idx" ON "artwork_order_events"("artworkOrderId");

-- CreateIndex
CREATE INDEX "artwork_portal_invites_artworkOrderId_idx" ON "artwork_portal_invites"("artworkOrderId");

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_sizeTierId_fkey" FOREIGN KEY ("sizeTierId") REFERENCES "artwork_size_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_files" ADD CONSTRAINT "artwork_files_artworkOrderId_fkey" FOREIGN KEY ("artworkOrderId") REFERENCES "artwork_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_order_events" ADD CONSTRAINT "artwork_order_events_artworkOrderId_fkey" FOREIGN KEY ("artworkOrderId") REFERENCES "artwork_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_portal_invites" ADD CONSTRAINT "artwork_portal_invites_artworkOrderId_fkey" FOREIGN KEY ("artworkOrderId") REFERENCES "artwork_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
