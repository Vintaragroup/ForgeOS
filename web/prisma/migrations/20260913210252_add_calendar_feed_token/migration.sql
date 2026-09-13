-- CreateTable
CREATE TABLE "calendar_feed_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "calendar_feed_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_feed_tokens_userId_idx" ON "calendar_feed_tokens"("userId");

-- AddForeignKey
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
