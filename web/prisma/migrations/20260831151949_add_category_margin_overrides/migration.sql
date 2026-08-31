-- CreateTable
CREATE TABLE "category_margin_overrides" (
    "id" TEXT NOT NULL,
    "estimateVersionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "marginPct" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "category_margin_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_margin_overrides_estimateVersionId_categoryId_key" ON "category_margin_overrides"("estimateVersionId", "categoryId");

-- AddForeignKey
ALTER TABLE "category_margin_overrides" ADD CONSTRAINT "category_margin_overrides_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category_margin_overrides" ADD CONSTRAINT "category_margin_overrides_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
