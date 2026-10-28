ALTER TABLE "platform_controls" ADD COLUMN "early_closed_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "early_closed_by" text;