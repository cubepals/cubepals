CREATE TYPE "public"."player_action_kind" AS ENUM('place', 'game_mode');--> statement-breakpoint
CREATE TABLE "player_actions_waiting" (
	"server_id" uuid NOT NULL,
	"player_uuid" uuid NOT NULL,
	"kind" "player_action_kind" NOT NULL,
	"what" text NOT NULL,
	"player_name" text NOT NULL,
	"requested_by" text NOT NULL,
	"asked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "player_actions_waiting_server_id_player_uuid_kind_pk" PRIMARY KEY("server_id","player_uuid","kind")
);
--> statement-breakpoint
CREATE TABLE "server_player_snapshots" (
	"server_id" uuid NOT NULL,
	"player_uuid" uuid NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"facts" jsonb NOT NULL,
	CONSTRAINT "server_player_snapshots_server_id_player_uuid_pk" PRIMARY KEY("server_id","player_uuid")
);
--> statement-breakpoint
ALTER TABLE "player_actions_waiting" ADD CONSTRAINT "player_actions_waiting_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_player_snapshots" ADD CONSTRAINT "server_player_snapshots_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;