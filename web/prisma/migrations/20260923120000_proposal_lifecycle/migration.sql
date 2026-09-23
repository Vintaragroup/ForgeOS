-- Proposal lifecycle: where a proposal stands with the client, and one
-- row per transition.
--
-- Proposal carried only sentAt and signedAt, so everything between "we
-- sent it" and "they signed it" left no trace: the review, the meeting,
-- and the request that produced the next EstimateVersion. A new version
-- simply appeared with nothing to say why it existed.

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'SENT', 'UNDER_REVIEW', 'REVISIONS_REQUESTED', 'SIGNED', 'DECLINED');

-- AlterTable
ALTER TABLE "proposals" ADD COLUMN     "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT';

-- CreateTable
CREATE TABLE "proposal_events" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "fromStatus" "ProposalStatus",
    "toStatus" "ProposalStatus" NOT NULL,
    "note" TEXT,
    "byUserId" TEXT,
    "estimateVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proposal_events_proposalId_idx" ON "proposal_events"("proposalId");

-- AddForeignKey
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_byUserId_fkey" FOREIGN KEY ("byUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proposal_events" ADD CONSTRAINT "proposal_events_estimateVersionId_fkey" FOREIGN KEY ("estimateVersionId") REFERENCES "estimate_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill status from the timestamps that already exist, so no proposal
-- starts life claiming to be a DRAFT it isn't. Signed beats sent: a
-- signed proposal always has both.
UPDATE "proposals" SET "status" = 'SIGNED' WHERE "signedAt" IS NOT NULL;
UPDATE "proposals" SET "status" = 'SENT'   WHERE "signedAt" IS NULL AND "sentAt" IS NOT NULL;

-- Seed history from those same timestamps. Only from real recorded dates
-- -- nothing is invented. byUserId stays null because the old columns
-- never recorded who sent or signed, and guessing would be worse than an
-- honest blank.
INSERT INTO "proposal_events" ("id", "proposalId", "fromStatus", "toStatus", "note", "byUserId", "estimateVersionId", "createdAt")
SELECT
  'seed-sent-' || "id",
  "id",
  'DRAFT',
  'SENT',
  'Recorded from the proposal''s own sent date, before this history existed.',
  NULL,
  "estimateVersionId",
  "sentAt"
FROM "proposals"
WHERE "sentAt" IS NOT NULL AND "deletedAt" IS NULL;

INSERT INTO "proposal_events" ("id", "proposalId", "fromStatus", "toStatus", "note", "byUserId", "estimateVersionId", "createdAt")
SELECT
  'seed-signed-' || "id",
  "id",
  'SENT',
  'SIGNED',
  'Recorded from the proposal''s own signed date, before this history existed.',
  NULL,
  "estimateVersionId",
  "signedAt"
FROM "proposals"
WHERE "signedAt" IS NOT NULL AND "deletedAt" IS NULL;
