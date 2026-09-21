-- AlterTable
ALTER TABLE "offices" ADD COLUMN     "hasProductionArtists" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasSignShop" BOOLEAN NOT NULL DEFAULT false;


-- Miami is the only Expo facility with its own Sign Shop Associates and
-- Production Artists, confirmed by the Graphics Manager on 2026-09-21.
-- Set here rather than in a script so it travels with the column: a
-- deploy that adds the flags without setting them would silently claim
-- no office can produce anything.
UPDATE "offices" SET "hasSignShop" = true, "hasProductionArtists" = true WHERE "code" = 'MIA';
