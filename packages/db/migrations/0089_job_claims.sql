-- A scheduled job is taken once a minute by the worker that runs it, here, rather than sent through the job queue.
ALTER TABLE "job_health" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_health" ADD COLUMN "claimed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_health" ADD COLUMN "run_asked_at" timestamp with time zone;