-- Catalog redesign phase 1, push 2: cut-list parts/sheets/remnants point at
-- the unified catalog_items instead of materials. Hand-edited from Prisma's
-- generated SQL, which added catalogItemId as NOT NULL with no value --
-- impossible on a non-empty table. Instead: add nullable, backfill through
-- catalog_items."legacyMaterialId" (populated by
-- scripts/migrate-catalog-to-unified.ts, already applied to every
-- environment before this runs), fail loudly if anything is left
-- unmapped, then enforce NOT NULL.
--
-- materialId is kept (now nullable, no longer written) so the previous
-- app version still works if this deploy has to be rolled back; it's
-- dropped with the materials table in push 3.

-- DropForeignKey (re-added below as ON DELETE SET NULL for the now-nullable column)
ALTER TABLE "cut_list_parts" DROP CONSTRAINT "cut_list_parts_materialId_fkey";
ALTER TABLE "cut_sheets" DROP CONSTRAINT "cut_sheets_materialId_fkey";
ALTER TABLE "material_remnants" DROP CONSTRAINT "material_remnants_materialId_fkey";

-- Expand: nullable new column, legacy column relaxed
ALTER TABLE "cut_list_parts" ADD COLUMN "catalogItemId" TEXT, ALTER COLUMN "materialId" DROP NOT NULL;
ALTER TABLE "cut_sheets" ADD COLUMN "catalogItemId" TEXT, ALTER COLUMN "materialId" DROP NOT NULL;
ALTER TABLE "material_remnants" ADD COLUMN "catalogItemId" TEXT, ALTER COLUMN "materialId" DROP NOT NULL;

-- Backfill through the migration trace
UPDATE "cut_list_parts" t SET "catalogItemId" = c."id"
  FROM "catalog_items" c WHERE c."legacyMaterialId" = t."materialId";
UPDATE "cut_sheets" t SET "catalogItemId" = c."id"
  FROM "catalog_items" c WHERE c."legacyMaterialId" = t."materialId";
UPDATE "material_remnants" t SET "catalogItemId" = c."id"
  FROM "catalog_items" c WHERE c."legacyMaterialId" = t."materialId";

-- Refuse to continue with an unmapped row -- that would mean the catalog
-- migration script wasn't run (or a material was created after it), and
-- the fix is to run it, not to lose the part.
DO $$
DECLARE
  unmapped INTEGER;
BEGIN
  SELECT (SELECT count(*) FROM "cut_list_parts" WHERE "catalogItemId" IS NULL)
       + (SELECT count(*) FROM "cut_sheets" WHERE "catalogItemId" IS NULL)
       + (SELECT count(*) FROM "material_remnants" WHERE "catalogItemId" IS NULL)
    INTO unmapped;
  IF unmapped > 0 THEN
    RAISE EXCEPTION '% cut-list row(s) have no catalog item -- run scripts/migrate-catalog-to-unified.ts --apply against this database, then redeploy.', unmapped;
  END IF;
END $$;

-- Contract the new column
ALTER TABLE "cut_list_parts" ALTER COLUMN "catalogItemId" SET NOT NULL;
ALTER TABLE "cut_sheets" ALTER COLUMN "catalogItemId" SET NOT NULL;
ALTER TABLE "material_remnants" ALTER COLUMN "catalogItemId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "cut_list_parts" ADD CONSTRAINT "cut_list_parts_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cut_list_parts" ADD CONSTRAINT "cut_list_parts_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cut_sheets" ADD CONSTRAINT "cut_sheets_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cut_sheets" ADD CONSTRAINT "cut_sheets_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "material_remnants" ADD CONSTRAINT "material_remnants_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "catalog_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "material_remnants" ADD CONSTRAINT "material_remnants_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "materials"("id") ON DELETE SET NULL ON UPDATE CASCADE;
