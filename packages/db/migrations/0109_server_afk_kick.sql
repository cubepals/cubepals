ALTER TABLE "minecraft_servers" ADD COLUMN "afk_kick_minutes" integer;
--> statement-breakpoint
-- Preserve account choices as they are when this migration runs. An old release still
-- serving during rollout can save a later account choice; that save is not copied again.
UPDATE "minecraft_servers" AS s
SET "afk_kick_minutes" = a."afk_kick_minutes"
FROM "account_standing" AS a
WHERE s."owner_id" = a."user_id" AND a."afk_kick_minutes" IS NOT NULL;
