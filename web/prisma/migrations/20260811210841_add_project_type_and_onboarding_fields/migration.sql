-- CreateEnum
CREATE TYPE "ProjectType" AS ENUM ('TRADESHOW_EXHIBIT', 'EVENT', 'EXHIBITOR_CONTRACTING', 'SPECIALIZED_PROJECT', 'OTHER');

-- CreateEnum
CREATE TYPE "BoothType" AS ENUM ('RENTAL', 'PURCHASE', 'CLIENT_OWNED');

-- CreateEnum
CREATE TYPE "BoothSpace" AS ENUM ('ISLAND', 'PENINSULA', 'IN_LINE', 'PERIMETER');

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "boothSize" TEXT,
ADD COLUMN     "boothSpace" "BoothSpace",
ADD COLUMN     "boothType" "BoothType",
ADD COLUMN     "eventEndDate" TIMESTAMP(3),
ADD COLUMN     "eventStartDate" TIMESTAMP(3),
ADD COLUMN     "projectDetails" TEXT,
ADD COLUMN     "projectType" "ProjectType" NOT NULL DEFAULT 'TRADESHOW_EXHIBIT',
ADD COLUMN     "shipDate" TIMESTAMP(3),
ADD COLUMN     "siteAddress" TEXT,
ADD COLUMN     "venue" TEXT;
