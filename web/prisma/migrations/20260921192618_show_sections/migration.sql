-- CreateTable
CREATE TABLE "show_sections" (
    "id" TEXT NOT NULL,
    "showId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "boothStart" INTEGER NOT NULL,
    "boothEnd" INTEGER NOT NULL,
    "leadUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "show_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "show_sections_showId_idx" ON "show_sections"("showId");

-- CreateIndex
CREATE UNIQUE INDEX "show_sections_showId_name_key" ON "show_sections"("showId", "name");

-- AddForeignKey
ALTER TABLE "show_sections" ADD CONSTRAINT "show_sections_showId_fkey" FOREIGN KEY ("showId") REFERENCES "shows"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "show_sections" ADD CONSTRAINT "show_sections_leadUserId_fkey" FOREIGN KEY ("leadUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

