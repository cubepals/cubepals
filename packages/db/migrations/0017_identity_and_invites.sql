ALTER TABLE "minecraft_servers" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- Every server gets an invite code: twelve characters nobody can guess, made here for the
-- servers that already exist and by the control plane for every new one.
ALTER TABLE "minecraft_servers" ADD COLUMN "invite_code" text;--> statement-breakpoint
UPDATE "minecraft_servers" SET "invite_code" = substr(translate(md5(random()::text || "id"::text || clock_timestamp()::text), '01', 'pq'), 1, 12);--> statement-breakpoint
ALTER TABLE "minecraft_servers" ALTER COLUMN "invite_code" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "servers_invite_code" ON "minecraft_servers" USING btree ("invite_code");--> statement-breakpoint
-- What a listing said moves onto the server it describes: from here on, a server's own name is
-- its title, and its own description is what the directory shows.
UPDATE "minecraft_servers" AS s SET "description" = l."description", "tags" = l."tags" FROM "public_listings" AS l WHERE l."server_id" = s."id";--> statement-breakpoint
UPDATE "public_listings" SET "visibility" = 'unpublished' WHERE "visibility" = 'draft';--> statement-breakpoint
ALTER TABLE "public_listings" ALTER COLUMN "visibility" SET DEFAULT 'unpublished';--> statement-breakpoint
ALTER TABLE "public_listings" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "public_listings" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "public_listings" DROP COLUMN "tags";
