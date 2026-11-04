ALTER TABLE "minecraft_servers" ADD COLUMN "afk_kick_minutes" integer;
--> statement-breakpoint
UPDATE "minecraft_servers" AS s
SET "afk_kick_minutes" = a."afk_kick_minutes"
FROM "account_standing" AS a
WHERE s."owner_id" = a."user_id" AND a."afk_kick_minutes" IS NOT NULL;
