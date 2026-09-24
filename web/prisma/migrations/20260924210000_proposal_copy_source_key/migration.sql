-- What a written scope summary was written ABOUT, so it can be known to
-- have gone stale.
--
-- These summaries are generated from line-item descriptions and nothing
-- else. On ABC Chicago a booth summary describing "a large LED screen
-- measuring 8 feet high by over 11 feet wide" survived its section being
-- cut to one row reading '60" LED monitors attached to areas of the
-- exhibit', and was still being printed for a client with nothing
-- anywhere saying so.
--
-- Recorded at APPROVAL, not generation: the approved text is what prints,
-- so the approved text is what has to be checked.
--
-- Expand-only. Null on every existing row, which reads as "written before
-- this check existed" and is reported as unknown rather than stale --
-- crying wolf over every summary ever written would bury the two that are
-- genuinely wrong.
ALTER TABLE "estimate_sections" ADD COLUMN "boothSummaryKey" TEXT;
ALTER TABLE "estimate_sections" ADD COLUMN "elementSummaryKey" TEXT;
