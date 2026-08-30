-- CreateEnum
CREATE TYPE "SectionBuildType" AS ENUM ('RENTAL', 'CUSTOM_BUILD');

-- AlterTable
ALTER TABLE "estimate_sections" ADD COLUMN     "buildType" "SectionBuildType";
