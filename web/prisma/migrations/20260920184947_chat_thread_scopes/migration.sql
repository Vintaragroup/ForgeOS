-- CreateEnum
CREATE TYPE "ChatThreadScope" AS ENUM ('OPPORTUNITY', 'SALES');

-- DropForeignKey
ALTER TABLE "chat_threads" DROP CONSTRAINT "chat_threads_opportunityId_fkey";

-- DropIndex
DROP INDEX "chat_threads_opportunityId_key";

-- AlterTable
ALTER TABLE "chat_threads" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "lastMessageAt" TIMESTAMP(3),
ADD COLUMN     "scope" "ChatThreadScope" NOT NULL DEFAULT 'OPPORTUNITY',
ADD COLUMN     "title" TEXT,
ADD COLUMN     "userId" TEXT,
ALTER COLUMN "opportunityId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "chat_threads_opportunityId_lastMessageAt_idx" ON "chat_threads"("opportunityId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "chat_threads_userId_lastMessageAt_idx" ON "chat_threads"("userId", "lastMessageAt");

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: existing threads are all per-opportunity, and their sort key
-- (lastMessageAt) can be recovered from the messages they already hold.
-- A thread with no messages keeps its creation time so it still sorts.
UPDATE "chat_threads" t
SET "lastMessageAt" = COALESCE(
  (SELECT MAX(m."createdAt") FROM "chat_messages" m WHERE m."threadId" = t."id"),
  t."createdAt"
)
WHERE t."lastMessageAt" IS NULL;
