-- Cost tracking for the re-cost review's one AI stage, kept separate so
-- it can be read on its own -- this is the stage whose value has to
-- justify itself against four deterministic ones that cost nothing.
--
-- Expand-only: adding a value to an enum invalidates no existing row.
ALTER TYPE "AiFeature" ADD VALUE 'RECOST_PROPOSALS';
