-- Stop cheaters: whether each server runs it, and the players it removed.
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
	"take_over" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_removals" ADD CONSTRAINT "server_removals_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_stop_cheaters" ADD CONSTRAINT "server_stop_cheaters_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_removals_server_at" ON "server_removals" USING btree ("server_id","at");--> statement-breakpoint
CREATE INDEX "server_removals_player" ON "server_removals" USING btree ("server_id","player_uuid","at");--> statement-breakpoint
-- Once: servers already published, as publishing does from now on. Their next start places it;
-- no running server restarts for this.
INSERT INTO "server_stop_cheaters" ("server_id", "setting", "reason")
SELECT l."server_id", 'on', 'browse' FROM "public_listings" l WHERE l."visibility" = 'published'
ON CONFLICT ("server_id") DO UPDATE SET "setting" = 'on', "reason" = 'browse'
WHERE "server_stop_cheaters"."setting" = 'auto';
