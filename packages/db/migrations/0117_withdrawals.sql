CREATE TABLE "billing_withdrawals" (
	"provider" text NOT NULL,
	"external_order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"played_milli" integer NOT NULL,
	"included_units" integer,
	"paid_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"refund_cents" integer NOT NULL,
	"rule" text NOT NULL,
	"earlier_full" boolean NOT NULL,
	"sent_to" text NOT NULL,
	CONSTRAINT "billing_withdrawals_provider_external_order_id_pk" PRIMARY KEY("provider","external_order_id"),
	CONSTRAINT "billing_withdrawals_kind" CHECK ("billing_withdrawals"."kind" in ('plan', 'year', 'gift', 'chip_in')),
	CONSTRAINT "billing_withdrawals_rule" CHECK ("billing_withdrawals"."rule" in ('full', 'played', 'unstarted', 'unredeemed', 'unplayed')),
	CONSTRAINT "billing_withdrawals_refund" CHECK ("billing_withdrawals"."refund_cents" between 0 and "billing_withdrawals"."paid_cents")
);
--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "chip_ins" ADD COLUMN "withdrawn_milli" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_withdrawals" ADD CONSTRAINT "billing_withdrawals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_withdrawals_user" ON "billing_withdrawals" USING btree ("user_id","requested_at");