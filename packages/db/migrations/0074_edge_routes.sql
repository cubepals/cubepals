CREATE TABLE "edges" (
	"edge_id" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"synced_to" timestamp with time zone,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "ready_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "route_listed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "routed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "minecraft_servers" SET "routed_at" = now() WHERE "status" = 'running';
