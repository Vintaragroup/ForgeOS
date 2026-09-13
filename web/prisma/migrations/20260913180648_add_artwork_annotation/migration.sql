-- CreateTable
CREATE TABLE "artwork_annotations" (
    "id" TEXT NOT NULL,
    "artworkFileId" TEXT NOT NULL,
    "page" INTEGER NOT NULL DEFAULT 1,
    "xPct" DOUBLE PRECISION NOT NULL,
    "yPct" DOUBLE PRECISION NOT NULL,
    "note" TEXT NOT NULL,
    "authorType" "ArtworkActorType" NOT NULL,
    "authorUserId" TEXT,
    "authorEmail" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_annotations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "artwork_annotations_artworkFileId_idx" ON "artwork_annotations"("artworkFileId");

-- AddForeignKey
ALTER TABLE "artwork_annotations" ADD CONSTRAINT "artwork_annotations_artworkFileId_fkey" FOREIGN KEY ("artworkFileId") REFERENCES "artwork_files"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
