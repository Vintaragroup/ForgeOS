-- Whether a document is still the authority for what it produced.
--
-- Losing currency removes nothing: the line items a document created stay
-- in the estimate and keep costing money, they just stop having a current
-- source. See docs/recost-review.md.
--
-- Expand-only. Every existing row defaults to CURRENT, which is true --
-- nothing has been marked otherwise yet. The backfill of SUPERSEDED from
-- the existing supersedes chain is deliberately NOT done here: it is a
-- derived read the application already makes, and writing it would make
-- the column disagree with the chain the moment a link changes.
CREATE TYPE "DocumentValidity" AS ENUM ('CURRENT', 'SUPERSEDED', 'WITHDRAWN');

ALTER TABLE "documents" ADD COLUMN "validity" "DocumentValidity" NOT NULL DEFAULT 'CURRENT';
ALTER TABLE "documents" ADD COLUMN "validityNote" TEXT;
ALTER TABLE "documents" ADD COLUMN "validityAt" TIMESTAMP(3);
