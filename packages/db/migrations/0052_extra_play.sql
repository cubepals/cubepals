ALTER TYPE "public"."stop_reason" ADD VALUE 'hours';--> statement-breakpoint
ALTER TYPE "public"."stop_reason" ADD VALUE 'unpaid';--> statement-breakpoint
CREATE TABLE "extra_play_months" (
	"user_id" text NOT NULL,
	"month" date NOT NULL,
	"accrued_milli" integer DEFAULT 0 NOT NULL,
	"reported_milli" integer DEFAULT 0 NOT NULL,
	"pending_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extra_play_months_user_id_month_pk" PRIMARY KEY("user_id","month")
);
--> statement-breakpoint
CREATE TABLE "extra_play_reports" (
	"external_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"month" date NOT NULL,
	"milli" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "extra_warned" text;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "status" text DEFAULT 'paid' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "extra_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "external_subscription_id" text;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "failure_told_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_orders" ADD COLUMN "owing_told_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extra_play_months" ADD CONSTRAINT "extra_play_months_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extra_play_reports" ADD CONSTRAINT "extra_play_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "extra_play_reports_unsent" ON "extra_play_reports" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "extra_play_reports_user" ON "extra_play_reports" USING btree ("user_id","month");