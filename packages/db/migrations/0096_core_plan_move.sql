ALTER TABLE "billing_subscriptions" ADD COLUMN "moves_to_plan" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "moves_at" timestamp with time zone;