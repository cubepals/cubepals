-- Every join as one row put together from the edge and the server, the signals raised on them, and
-- each server's last boot report. Kept 35 days; a join's source address an hour at most.
CREATE TABLE "joins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"server_id" uuid,
	"edge_id" text,
	"edge_region" text,
	"address" text NOT NULL,
	"address_kind" text,
	"protocol" integer,
	"player_name" text,
	"player_uuid" uuid,
	"network" text,
	"source" text,
	"path" text,
	"pinged_at" timestamp with time zone,
	"connected_at" timestamp with time zone NOT NULL,
	"wake_asked_at" timestamp with time zone,
	"wake_operation_id" uuid,
	"ready_at" timestamp with time zone,
	"handed_at" timestamp with time zone,
	"login_at" timestamp with time zone,
	"configure_started_at" timestamp with time zone,
	"configured_at" timestamp with time zone,
	"in_world_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"left_reason" text,
	"pinged_after_at" timestamp with time zone,
	"bytes_up" bigint,
	"bytes_down" bigint,
	"tick" jsonb,
	"server_side" text DEFAULT 'not_reported' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_reports" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"reported_at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"server_id" uuid,
	"join_id" uuid,
	"key" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	CONSTRAINT "signals_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "joins" ADD CONSTRAINT "joins_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_reports" ADD CONSTRAINT "server_reports_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "joins_server" ON "joins" USING btree ("server_id","connected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "joins_player" ON "joins" USING btree ("player_uuid","connected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "joins_player_name" ON "joins" USING btree (lower("player_name"),"connected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "joins_address" ON "joins" USING btree ("address","connected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "joins_source" ON "joins" USING btree ("source") WHERE "joins"."source" is not null;--> statement-breakpoint
CREATE INDEX "signals_at" ON "signals" USING btree ("at");--> statement-breakpoint
CREATE INDEX "signals_open" ON "signals" USING btree ("at") WHERE "signals"."closed_at" is null;