-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "packedAt" TIMESTAMP(3),
ADD COLUMN     "skidId" TEXT;

-- CreateTable
CREATE TABLE "skids" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "labelColor" TEXT,
    "sentAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "skids_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "skids_showId_idx" ON "skids"("showId");

-- CreateIndex
CREATE UNIQUE INDEX "skids_showId_code_key" ON "skids"("showId", "code");

-- AddForeignKey
ALTER TABLE "skids" ADD CONSTRAINT "skids_showId_fkey" FOREIGN KEY ("showId") REFERENCES "shows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork_orders" ADD CONSTRAINT "artwork_orders_skidId_fkey" FOREIGN KEY ("skidId") REFERENCES "skids"("id") ON DELETE SET NULL ON UPDATE CASCADE;

