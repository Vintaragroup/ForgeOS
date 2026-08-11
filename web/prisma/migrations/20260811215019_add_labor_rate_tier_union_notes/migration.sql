-- CreateEnum
CREATE TYPE "LaborRateTier" AS ENUM ('STRAIGHT_TIME', 'OVERTIME', 'DOUBLE_TIME');

-- CreateEnum
CREATE TYPE "LaborUnionStatus" AS ENUM ('UNION', 'NON_UNION');

-- AlterTable
ALTER TABLE "labor_rates" ADD COLUMN     "laborTier" "LaborRateTier",
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "unionStatus" "LaborUnionStatus";
