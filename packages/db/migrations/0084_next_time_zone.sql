-- A time zone reported mid-month waits for the next month, and the zone in force says when it took over.
ALTER TABLE "account_standing" ADD COLUMN "time_zone_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "time_zone_began" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "next_time_zone" text;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "next_time_zone_from" timestamp with time zone;