CREATE TABLE "server_players" (
	"server_id" uuid NOT NULL,
	"player_uuid" uuid NOT NULL,
	"player_name" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "server_players_server_id_player_uuid_pk" PRIMARY KEY("server_id","player_uuid")
);
--> statement-breakpoint
ALTER TABLE "server_players" ADD CONSTRAINT "server_players_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Whoever is on a server as this runs is the first of the people it has seen: its history starts
-- with them, first and last seen when presence last saw them.
INSERT INTO "server_players" ("server_id", "player_uuid", "player_name", "first_seen_at", "last_seen_at") SELECT p."server_id", p."player_uuid", p."player_name", p."seen_at", p."seen_at" FROM "server_presence" AS p JOIN "minecraft_servers" AS s ON s."id" = p."server_id";