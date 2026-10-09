ALTER TABLE "backups" ADD COLUMN "sha256" text;
-- What the runtime that wrote an archive said its bytes hash to, so a restore from it can be
-- checked. Archives made before this, and uploaded worlds, have none.
