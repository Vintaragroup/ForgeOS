-- CreateEnum
CREATE TYPE "OpportunityNoteKind" AS ENUM ('CLIENT_MEETING', 'CLIENT_CALL', 'INTERNAL', 'SITE_VISIT', 'OTHER');

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "designerId" TEXT,
ADD COLUMN     "estimatorId" TEXT,
ADD COLUMN     "exhibitorAccountRef" TEXT,
ADD COLUMN     "exhibitorKitUrl" TEXT,
ADD COLUMN     "hall" TEXT,
ADD COLUMN     "hallDetail" TEXT,
ADD COLUMN     "intakeSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "intakeSubmittedByUserId" TEXT,
ADD COLUMN     "reviewCompletedAt" TIMESTAMP(3),
ADD COLUMN     "reviewMeetingAt" TIMESTAMP(3),
ADD COLUMN     "showContactEmail" TEXT,
ADD COLUMN     "showContactName" TEXT,
ADD COLUMN     "showContactPhone" TEXT;

-- CreateTable
CREATE TABLE "opportunity_notes" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "kind" "OpportunityNoteKind" NOT NULL DEFAULT 'INTERNAL',
    "departmentCode" TEXT,
    "body" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "authorUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "opportunity_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "opportunity_show_deadlines" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "opportunity_show_deadlines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "opportunity_notes_opportunityId_occurredAt_idx" ON "opportunity_notes"("opportunityId", "occurredAt");

-- CreateIndex
CREATE INDEX "opportunity_show_deadlines_opportunityId_dueDate_idx" ON "opportunity_show_deadlines"("opportunityId", "dueDate");

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_intakeSubmittedByUserId_fkey" FOREIGN KEY ("intakeSubmittedByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_designerId_fkey" FOREIGN KEY ("designerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_estimatorId_fkey" FOREIGN KEY ("estimatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_notes" ADD CONSTRAINT "opportunity_notes_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_notes" ADD CONSTRAINT "opportunity_notes_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "opportunity_show_deadlines" ADD CONSTRAINT "opportunity_show_deadlines_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
