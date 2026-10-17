-- Who came to a server while it rested for its owner's play, so the owner sees who was turned away.
CREATE TABLE "server_turned_away" (
	"server_id" uuid NOT NULL,
	"player_uuid" uuid NOT NULL,
	"player_name" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "server_turned_away_server_id_player_uuid_pk" PRIMARY KEY("server_id","player_uuid")
);
--> statement-breakpoint
ALTER TABLE "server_turned_away" ADD CONSTRAINT "server_turned_away_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;