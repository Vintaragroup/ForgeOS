-- AlterTable
ALTER TABLE "salesmate_deals" ADD COLUMN     "previousStage" TEXT,
ADD COLUMN     "stageSince" TIMESTAMP(3),
ADD COLUMN     "statusChangedAt" TIMESTAMP(3);
