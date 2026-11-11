ALTER TABLE "billing_withdrawals" ADD COLUMN "also_orders" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Orders from before confirmations were sent need none: only purchases made from here on are told.
UPDATE "billing_orders" SET "confirmed_at" = now() WHERE "confirmed_at" IS NULL;
