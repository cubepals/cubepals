ALTER TYPE "public"."player_action_kind" ADD VALUE 'put_back';--> statement-breakpoint
CREATE TABLE "player_inventories_kept" (
	"server_id" uuid NOT NULL,
	"id" text NOT NULL,
	"player_uuid" uuid NOT NULL,
	"kept_at" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"items" jsonb NOT NULL,
	"putting_back_since" timestamp with time zone,
	CONSTRAINT "player_inventories_kept_server_id_id_pk" PRIMARY KEY("server_id","id")
);
--> statement-breakpoint
ALTER TABLE "player_inventories_kept" ADD CONSTRAINT "player_inventories_kept_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_inventories_kept_player" ON "player_inventories_kept" USING btree ("server_id","player_uuid");