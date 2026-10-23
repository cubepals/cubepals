ALTER TABLE "billing_orders" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_gifts" ALTER COLUMN "external_order_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_gifts" ALTER COLUMN "buyer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "gift_id" uuid;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "buyer_email" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "recipient_email" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "recipient_key" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "from_name" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "delivery" text DEFAULT 'code' NOT NULL;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "state" text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
UPDATE "plan_gifts" SET "state" = CASE WHEN "voided_at" IS NOT NULL THEN 'refunded' WHEN "redeemed_by" IS NOT NULL THEN 'claimed' ELSE 'paid' END;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "attached_to" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "claim_hash" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "manage_hash" text;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_gift_id_plan_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."plan_gifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_attached_to_users_id_fk" FOREIGN KEY ("attached_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plan_gifts_claim" ON "plan_gifts" USING btree ("claim_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_gifts_manage" ON "plan_gifts" USING btree ("manage_hash");--> statement-breakpoint
CREATE INDEX "plan_gifts_buyer_email" ON "plan_gifts" USING btree ("buyer_email","created_at");--> statement-breakpoint
CREATE INDEX "plan_gifts_recipient" ON "plan_gifts" USING btree ("recipient_key","created_at");--> statement-breakpoint
CREATE INDEX "plan_gifts_attached_to" ON "plan_gifts" USING btree ("attached_to");--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_payer" CHECK ("billing_orders"."user_id" is not null or "billing_orders"."gift_id" is not null);--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_buyer_known" CHECK ("plan_gifts"."buyer_id" is not null or "plan_gifts"."buyer_email" is not null);--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_guest_by_email" CHECK ("plan_gifts"."buyer_id" is not null or "plan_gifts"."delivery" = 'email');--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_paid_has_order" CHECK ("plan_gifts"."state" = 'checkout' or "plan_gifts"."external_order_id" is not null);--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_delivery" CHECK ("plan_gifts"."delivery" in ('code', 'email'));--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_emailed_has_recipient" CHECK ("plan_gifts"."delivery" = 'code' or "plan_gifts"."recipient_key" is not null);--> statement-breakpoint
ALTER TABLE "plan_gifts" ADD CONSTRAINT "plan_gifts_state" CHECK ("plan_gifts"."state" in ('checkout', 'paid', 'claimed', 'refunded'));