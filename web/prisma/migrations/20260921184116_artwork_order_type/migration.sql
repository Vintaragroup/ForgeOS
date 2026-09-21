-- CreateEnum
CREATE TYPE "ArtworkOrderType" AS ENUM ('EXHIBITOR', 'SHOW_MANAGEMENT', 'SITE');

-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "orderType" "ArtworkOrderType";


-- Backfill from the structure that already encodes most of this.
--
-- A piece tied to a client opportunity is that exhibitor's own booth
-- graphics; a piece tied only to a show is a shared common-area piece,
-- which is what showId was added for ("a shared/common-area piece that
-- isn't owned by any one client's deal").
--
-- SITE is deliberately NOT inferred. Nothing in the 639 rows we hold
-- distinguishes site signage from show-management work: the 67 show-level
-- pieces are named for PGA's own activations ("PGA Studio Stage / 12B",
-- "Career Services / 9A") and not one matches a site, hanging-sign or
-- wayfinding term. Guessing would put a third of a real show in the wrong
-- bucket; leaving it to be set explicitly costs nothing, since every one
-- of these rows is archived history.
UPDATE "artwork_orders" SET "orderType" = 'EXHIBITOR'
 WHERE "opportunityId" IS NOT NULL AND "orderType" IS NULL AND "deletedAt" IS NULL;

UPDATE "artwork_orders" SET "orderType" = 'SHOW_MANAGEMENT'
 WHERE "opportunityId" IS NULL AND "showId" IS NOT NULL AND "orderType" IS NULL AND "deletedAt" IS NULL;
