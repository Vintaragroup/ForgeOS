-- AlterEnum
ALTER TYPE "AiFeature" ADD VALUE 'RFP_CLARIFICATION_QUESTIONS';

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "clarificationQuestions" JSONB;
