-- Progress and stop reason for "Build from all analyzed documents".
--
-- That action processes every document on an opportunity in one server
-- action. On a real job -- The Pharmacy Hub, six documents including two
-- twelve-page drawings -- it ran for ten minutes and was killed by the
-- platform:
--
--   POST /estimates/... 504
--   Vercel Runtime Timeout Error: Task timed out after 600 seconds
--
-- The estimator saw "Something went wrong" and had no way to tell what
-- had run. A killed process cannot write down why it stopped, so the
-- build now stops ITSELF with time to spare and records the reason here.
--
-- Mirrors the per-document batch progress already on Document
-- (lineItemProposalBatchIndex/BatchTotal/StartedAt/Error), one tier up.
--
-- Expand-only, all nullable: a version that has never been built reads as
-- exactly that.
ALTER TABLE "estimate_versions" ADD COLUMN "buildStartedAt" TIMESTAMP(3);
ALTER TABLE "estimate_versions" ADD COLUMN "buildFinishedAt" TIMESTAMP(3);
ALTER TABLE "estimate_versions" ADD COLUMN "buildStoppedReason" TEXT;
ALTER TABLE "estimate_versions" ADD COLUMN "buildStepIndex" INTEGER;
ALTER TABLE "estimate_versions" ADD COLUMN "buildStepTotal" INTEGER;
ALTER TABLE "estimate_versions" ADD COLUMN "buildCurrentFile" TEXT;
