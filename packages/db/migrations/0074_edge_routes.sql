CREATE TABLE "edges" (
	"edge_id" text PRIMARY KEY NOT NULL,
	"synced_to" timestamp with time zone,
	"seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "route_listed_at" timestamp with time zone;