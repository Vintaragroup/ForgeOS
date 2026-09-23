-- A rep moving a proposal's status attests that they discussed it with
-- their manager or the department head first. Managers and admins move it
-- on their own authority, so the column stays false for them: it records a
-- claim someone actually made, not a box that was always ticked.
--
-- Defaults false, which is correct for every row that already exists --
-- those were seeded from sentAt/signedAt by the lifecycle migration and
-- nobody attested to anything.
ALTER TABLE "proposal_events" ADD COLUMN "managerConsulted" BOOLEAN NOT NULL DEFAULT false;
