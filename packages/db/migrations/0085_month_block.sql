-- The block of hours a month keeps when an admin lowers it after play, and the plan it was kept under.
ALTER TABLE "extra_play_months" ADD COLUMN "block_units" integer;--> statement-breakpoint
ALTER TABLE "extra_play_months" ADD COLUMN "block_plan" text;