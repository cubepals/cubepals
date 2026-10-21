-- Stop cheaters: whether each server runs it, the template it was made from, and the players it removed.
ALTER TYPE "public"."access_list" ADD VALUE 'unchecked';--> statement-breakpoint
CREATE TABLE "server_removals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"player_uuid" uuid NOT NULL,
	"player_name" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_stop_cheaters" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"setting" text DEFAULT 'auto' NOT NULL,
	"reason" text,
	"template" text,
	"take_over" boolean DEFAULT false NOT NULL,
	"removals_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "server_removals" ADD CONSTRAINT "server_removals_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_stop_cheaters" ADD CONSTRAINT "server_stop_cheaters_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_removals_server_at" ON "server_removals" USING btree ("server_id","at");--> statement-breakpoint
CREATE INDEX "server_removals_player" ON "server_removals" USING btree ("server_id","player_uuid","at");--> statement-breakpoint
-- The template each server was made from, as its creation was audited: Duels and Arcade servers
-- are on at `auto` with nothing else changed.
INSERT INTO "server_stop_cheaters" ("server_id", "template")
SELECT s."id", a."data"->>'template'
FROM "minecraft_servers" s
JOIN "audit_log" a ON a."subject_type" = 'server' AND a."subject_id" = s."id"::text AND a."action" = 'server.created'
WHERE a."data" ? 'template'
ON CONFLICT ("server_id") DO NOTHING;--> statement-breakpoint
-- Once: servers already published, as publishing does from now on. Their next start places it;
-- no running server restarts for this.
INSERT INTO "server_stop_cheaters" ("server_id", "setting", "reason")
SELECT l."server_id", 'on', 'browse' FROM "public_listings" l WHERE l."visibility" = 'published'
ON CONFLICT ("server_id") DO UPDATE SET "setting" = 'on', "reason" = 'browse'
WHERE "server_stop_cheaters"."setting" = 'auto';
