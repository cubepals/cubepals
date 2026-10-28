ALTER TABLE "billing_subscriptions" ADD COLUMN "product_id" text;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "price_cents" integer;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "included_units" integer;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD COLUMN "most_extra_units" integer;