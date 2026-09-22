-- CreateEnum
CREATE TYPE "GraphicMaterialClass" AS ENUM ('FABRIC', 'RIGID', 'HANGING_SIGN');

-- CreateTable
CREATE TABLE "graphic_materials" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "materialClass" "GraphicMaterialClass" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "graphic_materials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "graphic_materials_name_key" ON "graphic_materials"("name");


-- Seeded from the 20 distinct values in the PGA control log -- the only
-- real material vocabulary we have. The Microsoft List tracker carries no
-- material column at all, which is why the 282 Seatrade pieces have none.
INSERT INTO "graphic_materials" ("id", "name", "materialClass", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'PVC (White) - 1/8"', 'RIGID', true, 0, now(), now()),
  (gen_random_uuid()::text, 'Fabric (Black-Back)', 'FABRIC', true, 10, now(), now()),
  (gen_random_uuid()::text, 'Vinyl (White)', 'RIGID', true, 20, now(), now()),
  (gen_random_uuid()::text, 'PVC (Black) - 1/8"', 'RIGID', true, 30, now(), now()),
  (gen_random_uuid()::text, 'Vinyl (Black)', 'RIGID', true, 40, now(), now()),
  (gen_random_uuid()::text, 'Vinyl (RTA)', 'RIGID', true, 50, now(), now()),
  (gen_random_uuid()::text, 'PVC (Black) - 6mm', 'RIGID', true, 60, now(), now()),
  (gen_random_uuid()::text, 'PVC (White) - 6mm', 'RIGID', true, 70, now(), now()),
  (gen_random_uuid()::text, '1" Ultraboard - White', 'RIGID', true, 80, now(), now()),
  (gen_random_uuid()::text, 'Fabric (Eco - Gray back)', 'FABRIC', true, 90, now(), now()),
  (gen_random_uuid()::text, 'Fabric (Lightbox)', 'FABRIC', true, 100, now(), now()),
  (gen_random_uuid()::text, 'Acrylic / Plexi (Frost)', 'RIGID', true, 110, now(), now()),
  (gen_random_uuid()::text, 'Acrylic / Plexi (Clear) - 1/2"', 'RIGID', true, 120, now(), now()),
  (gen_random_uuid()::text, 'Acrylic / Plexi (Clear) - 3/16"', 'RIGID', true, 130, now(), now()),
  (gen_random_uuid()::text, 'Acrylic / Plexi (Milk) - 1/8"', 'RIGID', true, 140, now(), now()),
  (gen_random_uuid()::text, 'Foamboard - 3/16"', 'RIGID', true, 150, now(), now()),
  (gen_random_uuid()::text, 'Foamboard - 1/2"', 'RIGID', true, 160, now(), now()),
  (gen_random_uuid()::text, 'Sintra', 'RIGID', true, 170, now(), now()),
  (gen_random_uuid()::text, 'Scrim', 'FABRIC', true, 180, now(), now()),
  (gen_random_uuid()::text, 'Hanging Sign', 'HANGING_SIGN', false, 190, now(), now())
ON CONFLICT ("name") DO NOTHING;

-- Fold the spellings the log actually contains onto the canonical
-- names: "Acrlyic" appears on 3 of 5 acrylic rows, and Foamboard is
-- capitalised two ways. Done once here; the picker stops new variants.
UPDATE "artwork_orders" SET "material" = 'Acrylic / Plexi (Frost)' WHERE "material" = 'Acrlyic / Plexi (Frost)';
UPDATE "artwork_orders" SET "material" = 'Acrylic / Plexi (Clear) - 1/2"' WHERE "material" = 'Acrlyic / Plexi (Clear) - 1/2"';
UPDATE "artwork_orders" SET "material" = 'Acrylic / Plexi (Clear) - 3/16"' WHERE "material" = 'Acrlyic / Plexi (Clear) - 3/16"';
UPDATE "artwork_orders" SET "material" = 'Acrylic / Plexi (Milk) - 1/8"' WHERE "material" = 'Acrlyic / Plexi (Milk) - 1/8"';
UPDATE "artwork_orders" SET "material" = 'Foamboard - 3/16"' WHERE "material" = 'FoamBoard - 3/16"';
UPDATE "artwork_orders" SET "material" = 'Foamboard - 1/2"' WHERE "material" = 'FoamBoard - 1/2"';
