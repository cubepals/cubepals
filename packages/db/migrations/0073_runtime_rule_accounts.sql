ALTER TABLE "runtime_rules" ALTER COLUMN "accounts" SET DATA TYPE text[];--> statement-breakpoint
ALTER TABLE "runtime_rules" ALTER COLUMN "accounts" SET DEFAULT '{}'::text[];