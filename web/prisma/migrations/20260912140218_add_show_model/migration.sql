-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "showId" TEXT;

-- CreateTable
CREATE TABLE "shows" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "venue" TEXT,
    "eventStartDate" TIMESTAMP(3),
    "eventEndDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "shows_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_showId_fkey" FOREIGN KEY ("showId") REFERENCES "shows"("id") ON DELETE SET NULL ON UPDATE CASCADE;
