-- CreateEnum
CREATE TYPE "PostShowDiscardReason" AS ENUM ('DAMAGED_BEYOND_REPAIR', 'CLIENT_APPROVED_DISPOSAL', 'AGED_OUT');

-- AlterEnum
ALTER TYPE "ArtworkFileKind" ADD VALUE 'POST_SHOW_CONDITION_PHOTO';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PostShowCondition" ADD VALUE 'NEW';
ALTER TYPE "PostShowCondition" ADD VALUE 'AGING';

-- AlterTable
ALTER TABLE "artwork_orders" ADD COLUMN     "postShowConditionNote" TEXT,
ADD COLUMN     "postShowDiscardReason" "PostShowDiscardReason",
ADD COLUMN     "postShowDisposalApprovedBy" TEXT;
