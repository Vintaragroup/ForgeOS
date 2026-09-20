-- DropIndex
DROP INDEX "salesmate_companies_companyId_key";

-- CreateIndex
CREATE INDEX "salesmate_companies_companyId_idx" ON "salesmate_companies"("companyId");
