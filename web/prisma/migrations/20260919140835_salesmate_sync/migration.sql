-- CreateEnum
CREATE TYPE "SalesmateSyncTrigger" AS ENUM ('CRON', 'MANUAL', 'SCRIPT');

-- CreateEnum
CREATE TYPE "SalesmateSyncStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "lastContactedAt" TIMESTAMP(3),
ADD COLUMN     "lastContactedBy" TEXT,
ADD COLUMN     "lastContactedMode" TEXT,
ADD COLUMN     "mobile" TEXT,
ADD COLUMN     "salesmateId" TEXT,
ADD COLUMN     "salesmateSyncedAt" TIMESTAMP(3),
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "salesmate_companies" (
    "salesmateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "address" TEXT,
    "ownerName" TEXT,
    "lastCommunicationAt" TIMESTAMP(3),
    "lastCommunicationMode" TEXT,
    "lastCommunicationBy" TEXT,
    "companyId" TEXT,
    "ignoredAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesmate_companies_pkey" PRIMARY KEY ("salesmateId")
);

-- CreateTable
CREATE TABLE "salesmate_deals" (
    "salesmateId" TEXT NOT NULL,
    "salesmateCompanyId" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "opportunityId" TEXT,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pipeline" TEXT,
    "stage" TEXT,
    "value" DECIMAL(14,2),
    "ownerName" TEXT,
    "salesmateCreatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "estimatedCloseAt" TIMESTAMP(3),
    "lastCommunicationAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesmate_deals_pkey" PRIMARY KEY ("salesmateId")
);

-- CreateTable
CREATE TABLE "salesmate_sync_runs" (
    "id" TEXT NOT NULL,
    "trigger" "SalesmateSyncTrigger" NOT NULL,
    "status" "SalesmateSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "triggeredByUserId" TEXT,
    "stats" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "salesmate_sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "salesmate_companies_companyId_key" ON "salesmate_companies"("companyId");

-- CreateIndex
CREATE INDEX "salesmate_deals_companyId_idx" ON "salesmate_deals"("companyId");

-- CreateIndex
CREATE INDEX "salesmate_deals_salesmateCompanyId_idx" ON "salesmate_deals"("salesmateCompanyId");

-- CreateIndex
CREATE INDEX "salesmate_sync_runs_startedAt_idx" ON "salesmate_sync_runs"("startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "contacts_salesmateId_key" ON "contacts"("salesmateId");

-- AddForeignKey
ALTER TABLE "salesmate_companies" ADD CONSTRAINT "salesmate_companies_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_deals" ADD CONSTRAINT "salesmate_deals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_deals" ADD CONSTRAINT "salesmate_deals_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_deals" ADD CONSTRAINT "salesmate_deals_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_sync_runs" ADD CONSTRAINT "salesmate_sync_runs_triggeredByUserId_fkey" FOREIGN KEY ("triggeredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
