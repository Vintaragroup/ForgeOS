-- CreateEnum
CREATE TYPE "CloseReason" AS ENUM ('PRICE', 'TIMELINE', 'SCOPE_FIT', 'COMPETITOR', 'BUDGET_CANCELLED', 'NO_RESPONSE', 'RELATIONSHIP', 'OTHER');

-- AlterTable
ALTER TABLE "opportunities" ADD COLUMN     "closeReason" "CloseReason",
ADD COLUMN     "closeReasonDetail" TEXT;
