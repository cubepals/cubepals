ALTER TABLE "platform_controls" ADD COLUMN "early_room_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "early_points_core" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "early_points_plus" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "early_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "early_room_set_at" timestamp with time zone;