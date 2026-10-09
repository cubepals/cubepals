CREATE TABLE "spend_days" (
	"day" date PRIMARY KEY NOT NULL,
	"compute_cents" integer NOT NULL,
	"stray_cents" integer NOT NULL,
	"storage_cents" integer NOT NULL,
	"stray_machines" integer NOT NULL,
	"running_servers" integer NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"tripped_at" timestamp with time zone,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"email" text PRIMARY KEY NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_controls" ALTER COLUMN "max_servers" SET DEFAULT 30;--> statement-breakpoint
ALTER TABLE "platform_controls" ALTER COLUMN "max_running_servers" SET DEFAULT 10;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "signup_medium" text;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "signup_campaign" text;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "signup_content" text;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "signup_term" text;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "max_free_accounts" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_controls" ADD COLUMN "daily_spend_limit_cents" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
-- The launch caps (docs/money-guards.md), on a deployment where no admin has set its own yet.
UPDATE "platform_controls" SET "max_servers" = 30, "max_running_servers" = 10 WHERE "id" = 1 AND "updated_by" IS NULL AND "max_servers" = 40 AND "max_running_servers" = 15;
