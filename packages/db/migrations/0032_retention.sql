ALTER TABLE "minecraft_servers" ADD COLUMN "deletion_warned" text;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "expiring_enabled" boolean DEFAULT false NOT NULL;