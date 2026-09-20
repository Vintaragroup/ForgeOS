-- CreateTable
CREATE TABLE "salesmate_activities" (
    "salesmateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAt" TIMESTAMP(3),
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "durationMinutes" INTEGER,
    "salesmateContactId" TEXT,
    "contactId" TEXT,
    "salesmateCompanyId" TEXT,
    "companyId" TEXT,
    "salesmateDealId" TEXT,
    "ownerSalesmateUserId" TEXT,
    "ownerUserId" TEXT,
    "salesmateCreatedAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "salesmate_activities_pkey" PRIMARY KEY ("salesmateId")
);

-- CreateTable
CREATE TABLE "client_touches" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "mode" TEXT,
    "byName" TEXT,
    "byUserId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'SALESMATE_LAST_COMMUNICATION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_touches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "salesmate_activities_companyId_idx" ON "salesmate_activities"("companyId");

-- CreateIndex
CREATE INDEX "salesmate_activities_contactId_idx" ON "salesmate_activities"("contactId");

-- CreateIndex
CREATE INDEX "salesmate_activities_ownerUserId_idx" ON "salesmate_activities"("ownerUserId");

-- CreateIndex
CREATE INDEX "salesmate_activities_dueAt_idx" ON "salesmate_activities"("dueAt");

-- CreateIndex
CREATE INDEX "client_touches_companyId_occurredAt_idx" ON "client_touches"("companyId", "occurredAt");

-- CreateIndex
CREATE INDEX "client_touches_byUserId_occurredAt_idx" ON "client_touches"("byUserId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "client_touches_companyId_contactId_occurredAt_key" ON "client_touches"("companyId", "contactId", "occurredAt");

-- AddForeignKey
ALTER TABLE "salesmate_activities" ADD CONSTRAINT "salesmate_activities_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_activities" ADD CONSTRAINT "salesmate_activities_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_activities" ADD CONSTRAINT "salesmate_activities_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_touches" ADD CONSTRAINT "client_touches_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_touches" ADD CONSTRAINT "client_touches_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
