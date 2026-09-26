-- The anchor dates an eleven-milestone timeline is computed from.
--
-- The estimating workbook has done this by hand for years: PROPOSAL!A14:A24
-- is the same eleven milestones ForgeOS models, and nine of them are plain
-- arithmetic on two dates.
--
--   deposit          = signed proposal + 5     artwork ready   = ship - 28
--   production mtg   = signed proposal + 7     50% rush cutoff = ship - 14
--                                              100% rush       = ship - 7
--                                              balance due     = ship - 5
--
-- ForgeOS was asking a model to read these off documents instead, which is
-- why a real job carried eleven AI_SUGGESTED milestones, none confirmed,
-- and an opportunity page that said "fill in 11 missing milestones".
--
-- Show gets the three date fields it lacked (it already had event start and
-- end), because these are show-dictated facts -- every exhibitor at one
-- show ships and installs to the same schedule. An opportunity inherits
-- them and can override per booth.
--
-- signedProposalTargetDate is the one genuinely per-opportunity anchor: the
-- date by which the client must sign for rush charges not to apply.
--
-- Expand-only. Null everywhere on existing rows, which reads as "no anchor
-- yet" and leaves the milestones that depend on it blank rather than
-- guessed.
ALTER TABLE "shows" ADD COLUMN "shipDate" TIMESTAMP(3);
ALTER TABLE "shows" ADD COLUMN "targetMoveIn" TIMESTAMP(3);
ALTER TABLE "shows" ADD COLUMN "targetMoveOut" TIMESTAMP(3);
ALTER TABLE "opportunities" ADD COLUMN "signedProposalTargetDate" TIMESTAMP(3);
