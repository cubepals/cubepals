ALTER TABLE "billing_orders" ADD COLUMN "owed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "settled_by" text;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "refund_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "canceled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "extra_play_months" ADD COLUMN "final_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extra_play_reports" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extra_play_reports" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
-- A balance used to mark what it paid with the status 'settled', which lost the provider's own
-- word on the order; it is kept apart now. Which balance paid them wasn't kept, so they say so.
UPDATE "billing_orders" SET "settled_by" = 'unknown', "status" = 'void' WHERE "status" = 'settled';
