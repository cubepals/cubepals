-- Undoes migrations/0097_gifts_by_email.sql, by hand: Drizzle only migrates forward. Gifts started
-- but never paid (`checkout`) are dropped. A gift a guest paid for has nowhere to go in the old
-- shape, so with one kept this refuses rather than lose a paid order.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "billing_orders" WHERE "user_id" IS NULL)
    OR EXISTS (SELECT 1 FROM "plan_gifts" WHERE "buyer_id" IS NULL AND "state" <> 'checkout') THEN
    RAISE EXCEPTION 'A guest paid for a gift: 0097 can''t be undone without losing its order';
  END IF;
END $$;
ALTER TABLE "billing_orders" DROP CONSTRAINT "billing_orders_payer";
ALTER TABLE "billing_orders" DROP COLUMN "gift_id";
DELETE FROM "plan_gifts" WHERE "state" = 'checkout';
ALTER TABLE "plan_gifts" DROP CONSTRAINT "plan_gifts_buyer_known";
ALTER TABLE "plan_gifts" DROP CONSTRAINT "plan_gifts_guest_by_email";
ALTER TABLE "plan_gifts" DROP CONSTRAINT "plan_gifts_paid_has_order";
ALTER TABLE "plan_gifts" DROP CONSTRAINT "plan_gifts_delivery";
ALTER TABLE "plan_gifts" DROP CONSTRAINT "plan_gifts_emailed_has_recipient";
ALTER TABLE "plan_gifts" DROP CONSTRAINT "plan_gifts_state";
DROP INDEX "plan_gifts_claim";
DROP INDEX "plan_gifts_manage";
DROP INDEX "plan_gifts_buyer_email";
DROP INDEX "plan_gifts_recipient";
DROP INDEX "plan_gifts_attached_to";
ALTER TABLE "plan_gifts" DROP COLUMN "buyer_email";
ALTER TABLE "plan_gifts" DROP COLUMN "recipient_email";
ALTER TABLE "plan_gifts" DROP COLUMN "recipient_key";
ALTER TABLE "plan_gifts" DROP COLUMN "from_name";
ALTER TABLE "plan_gifts" DROP COLUMN "note";
ALTER TABLE "plan_gifts" DROP COLUMN "delivery";
ALTER TABLE "plan_gifts" DROP COLUMN "state";
ALTER TABLE "plan_gifts" DROP COLUMN "attached_to";
ALTER TABLE "plan_gifts" DROP COLUMN "claim_hash";
ALTER TABLE "plan_gifts" DROP COLUMN "manage_hash";
ALTER TABLE "plan_gifts" DROP COLUMN "reminded_at";
ALTER TABLE "plan_gifts" DROP COLUMN "declined_at";
ALTER TABLE "plan_gifts" ALTER COLUMN "buyer_id" SET NOT NULL;
ALTER TABLE "plan_gifts" ALTER COLUMN "external_order_id" SET NOT NULL;
ALTER TABLE "billing_orders" ALTER COLUMN "user_id" SET NOT NULL;
