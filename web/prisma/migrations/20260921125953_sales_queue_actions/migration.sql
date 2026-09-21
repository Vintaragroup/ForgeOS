-- CreateEnum
CREATE TYPE "SalesQueue" AS ENUM ('FOLLOW_UP', 'PAST_DUE', 'STALLED_DEAL', 'WIN_BACK');

-- AlterTable
ALTER TABLE "client_touches" ADD COLUMN     "note" TEXT;

-- AlterTable
ALTER TABLE "salesmate_activities" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedByUserId" TEXT;

-- CreateTable
CREATE TABLE "sales_queue_snoozes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "queue" "SalesQueue" NOT NULL,
    "targetKey" TEXT NOT NULL,
    "snoozedUntil" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_queue_snoozes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_queue_snoozes_userId_snoozedUntil_idx" ON "sales_queue_snoozes"("userId", "snoozedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "sales_queue_snoozes_userId_queue_targetKey_key" ON "sales_queue_snoozes"("userId", "queue", "targetKey");

-- AddForeignKey
ALTER TABLE "sales_queue_snoozes" ADD CONSTRAINT "sales_queue_snoozes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

