-- The most a month's block of hours was during it: a block lowered mid-month applies from the next.
ALTER TABLE "extra_play_months" ADD COLUMN "block_units" integer;