-- Add key as nullable first (existing rows need a backfill before it can
-- be NOT NULL + UNIQUE).
ALTER TABLE "categories" ADD COLUMN "key" TEXT;

-- Backfill the 12 categories seeded by scripts/seed-categories.ts, matched
-- by their current name AND known pre-rename aliases -- "Custom Build" was
-- renamed to "Custom Build / Rental" this session (see
-- categories/actions.ts's rename cascade), so both names must resolve to
-- the same "custom_build" key here for that rename not to break this
-- backfill.
UPDATE "categories" SET "key" = 'custom_build' WHERE "name" IN ('Custom Build', 'Custom Build / Rental') AND "key" IS NULL;
UPDATE "categories" SET "key" = 'structure' WHERE "name" = 'Structure' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'flooring' WHERE "name" = 'Flooring' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'furniture' WHERE "name" = 'Furniture' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'accessories' WHERE "name" = 'Accessories' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'audio_visual' WHERE "name" = 'Audio/Visual' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'graphics' WHERE "name" = 'Graphics' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'signage' WHERE "name" = 'Signage' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'professional_services' WHERE "name" = 'Professional Services' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'labor' WHERE "name" = 'Labor' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'shipping' WHERE "name" = 'Shipping' AND "key" IS NULL;
UPDATE "categories" SET "key" = 'other' WHERE "name" = 'Other' AND "key" IS NULL;

-- Any remaining row (a category created via the UI after the seed, in any
-- environment) gets a generic slug of its current name, de-duplicated with
-- a numeric suffix on collision -- same algorithm createCategory uses for
-- every new category going forward.
WITH slugged AS (
  SELECT id, regexp_replace(lower(trim("name")), '[^a-z0-9]+', '_', 'g') AS base_slug
  FROM "categories" WHERE "key" IS NULL
), numbered AS (
  SELECT id, base_slug, row_number() OVER (PARTITION BY base_slug ORDER BY id) AS rn
  FROM slugged
)
UPDATE "categories" c
SET "key" = CASE WHEN n.rn = 1 THEN n.base_slug ELSE n.base_slug || '_' || n.rn END
FROM numbered n WHERE c.id = n.id;

ALTER TABLE "categories" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "categories_key_key" ON "categories"("key");
