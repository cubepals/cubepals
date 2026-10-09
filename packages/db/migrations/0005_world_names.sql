ALTER TABLE "worlds" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "worlds" SET "name" = initcap(replace("level_name", '-', ' ')) WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "worlds" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "pruned_at" timestamp with time zone;
