ALTER TABLE "power_intervals" ADD COLUMN "pinged" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "power_intervals" ADD COLUMN "joined_at" timestamp with time zone;