ALTER TYPE "public"."backup_trigger" ADD VALUE 'stored';--> statement-breakpoint
ALTER TYPE "public"."operation_kind" ADD VALUE 'store';--> statement-breakpoint
ALTER TYPE "public"."operation_kind" ADD VALUE 'unstore';--> statement-breakpoint
ALTER TYPE "public"."server_status" ADD VALUE 'storing';--> statement-breakpoint
ALTER TYPE "public"."server_status" ADD VALUE 'stored';--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- When each server was last played, or started by its owner, from what is already known: the
-- players it has seen, and the runs a person started. A run a connection woke says nothing.
UPDATE "minecraft_servers" AS s SET "last_active_at" = greatest(
  s."created_at",
  (SELECT max(p."last_seen_at") FROM "server_players" AS p WHERE p."server_id" = s."id"),
  (SELECT max(i."started_at") FROM "power_intervals" AS i WHERE i."server_id" = s."id" AND NOT i."woken")
);--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "stored_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "storing_enabled" boolean DEFAULT true NOT NULL;