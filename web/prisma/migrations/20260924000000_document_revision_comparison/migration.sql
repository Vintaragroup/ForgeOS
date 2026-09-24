-- What changed between a drawing and the drawing it supersedes, as a
-- DrawingComparison (see drawing-comparison-service.ts).
--
-- Expand-only: one nullable column, no backfill, no default. Every
-- existing row reads as "not compared yet", which is true.
ALTER TABLE "documents" ADD COLUMN "revisionComparison" JSONB;
