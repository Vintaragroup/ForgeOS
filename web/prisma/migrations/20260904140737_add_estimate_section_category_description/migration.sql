-- CreateTable
CREATE TABLE "estimate_section_category_descriptions" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "description" TEXT,
    "pendingDescription" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_section_category_descriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "estimate_section_category_descriptions_sectionId_categoryId_key" ON "estimate_section_category_descriptions"("sectionId", "categoryId");

-- AddForeignKey
ALTER TABLE "estimate_section_category_descriptions" ADD CONSTRAINT "estimate_section_category_descriptions_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "estimate_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_section_category_descriptions" ADD CONSTRAINT "estimate_section_category_descriptions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
