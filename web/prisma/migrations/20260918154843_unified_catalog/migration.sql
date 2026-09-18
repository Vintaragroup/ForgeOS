-- CreateEnum
CREATE TYPE "CatalogItemType" AS ENUM ('RENTAL', 'MATERIAL', 'SERVICE');

-- CreateTable
CREATE TABLE "offices" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isStandard" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "offices_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "catalog_categories" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "estimateCategoryKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "catalog_categories_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "catalog_number_sequences" (
    "itemType" "CatalogItemType" NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "catalog_number_sequences_pkey" PRIMARY KEY ("itemType","categoryCode")
);

-- CreateTable
CREATE TABLE "catalog_items" (
    "id" TEXT NOT NULL,
    "catalogNumber" TEXT NOT NULL,
    "itemType" "CatalogItemType" NOT NULL,
    "categoryCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT,
    "unitCost" DECIMAL(10,2),
    "unitPrice" DECIMAL(10,2),
    "sourceNote" TEXT,
    "materialType" "MaterialType",
    "stockWidth" DECIMAL(8,3),
    "stockLength" DECIMAL(8,3),
    "thickness" DECIMAL(8,3),
    "defaultKerf" DECIMAL(6,3),
    "grainDirectionMatters" BOOLEAN NOT NULL DEFAULT false,
    "legacyMaterialId" TEXT,
    "legacyRentalItemId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "catalog_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item_tags" (
    "catalogItemId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,

    CONSTRAINT "catalog_item_tags_pkey" PRIMARY KEY ("catalogItemId","tagId")
);

-- CreateTable
CREATE TABLE "catalog_item_aliases" (
    "id" TEXT NOT NULL,
    "catalogItemId" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalizedAlias" TEXT NOT NULL,
    "officeCode" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "catalog_item_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_catalogNumber_key" ON "catalog_items"("catalogNumber");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_legacyMaterialId_key" ON "catalog_items"("legacyMaterialId");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_items_legacyRentalItemId_key" ON "catalog_items"("legacyRentalItemId");

-- CreateIndex
CREATE INDEX "catalog_items_categoryCode_idx" ON "catalog_items"("categoryCode");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_tags_name_key" ON "catalog_tags"("name");

-- CreateIndex
CREATE INDEX "catalog_item_aliases_normalizedAlias_idx" ON "catalog_item_aliases"("normalizedAlias");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_aliases_catalogItemId_normalizedAlias_key" ON "catalog_item_aliases"("catalogItemId", "normalizedAlias");

-- AddForeignKey
ALTER TABLE "catalog_categories" ADD CONSTRAINT "catalog_categories_estimateCategoryKey_fkey" FOREIGN KEY ("estimateCategoryKey") REFERENCES "categories"("key") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_categoryCode_fkey" FOREIGN KEY ("categoryCode") REFERENCES "catalog_categories"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_tags" ADD CONSTRAINT "catalog_item_tags_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_tags" ADD CONSTRAINT "catalog_item_tags_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "catalog_tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_aliases" ADD CONSTRAINT "catalog_item_aliases_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "catalog_item_aliases" ADD CONSTRAINT "catalog_item_aliases_officeCode_fkey" FOREIGN KEY ("officeCode") REFERENCES "offices"("code") ON DELETE SET NULL ON UPDATE CASCADE;
