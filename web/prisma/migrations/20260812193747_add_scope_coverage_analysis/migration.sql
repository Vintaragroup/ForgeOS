-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'SCOPE_COVERAGE_ANALYSIS';

-- AlterTable
ALTER TABLE "estimate_versions" ADD COLUMN     "coverageAnalysis" JSONB;
