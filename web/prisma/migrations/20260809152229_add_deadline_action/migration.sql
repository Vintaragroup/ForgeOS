-- CreateEnum
CREATE TYPE "DeadlineActionStatus" AS ENUM ('SCHEDULED', 'SUBMITTED', 'PAID');

-- CreateTable
CREATE TABLE "deadline_actions" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "DeadlineActionStatus" NOT NULL,
    "actedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deadline_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deadline_actions_opportunityId_dedupeKey_key" ON "deadline_actions"("opportunityId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "deadline_actions" ADD CONSTRAINT "deadline_actions_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deadline_actions" ADD CONSTRAINT "deadline_actions_actedById_fkey" FOREIGN KEY ("actedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
