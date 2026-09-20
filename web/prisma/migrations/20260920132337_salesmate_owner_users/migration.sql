-- AlterTable
ALTER TABLE "salesmate_companies" ADD COLUMN     "ownerSalesmateUserId" TEXT,
ADD COLUMN     "ownerUserId" TEXT;

-- AlterTable
ALTER TABLE "salesmate_deals" ADD COLUMN     "ownerSalesmateUserId" TEXT,
ADD COLUMN     "ownerUserId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "salesmateUserId" TEXT;

-- CreateIndex
CREATE INDEX "salesmate_companies_ownerUserId_idx" ON "salesmate_companies"("ownerUserId");

-- CreateIndex
CREATE INDEX "salesmate_deals_ownerUserId_idx" ON "salesmate_deals"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "users_salesmateUserId_key" ON "users"("salesmateUserId");

-- AddForeignKey
ALTER TABLE "salesmate_companies" ADD CONSTRAINT "salesmate_companies_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "salesmate_deals" ADD CONSTRAINT "salesmate_deals_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
