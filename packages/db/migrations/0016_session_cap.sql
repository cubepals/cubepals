ALTER TYPE "public"."stop_reason" ADD VALUE 'session_cap';--> statement-breakpoint
ALTER TABLE "power_intervals" ADD COLUMN "session_warned_minutes" integer;