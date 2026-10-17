-- How each scheduled job, and the parts of one that fail on their own, last went.
CREATE TABLE "job_health" (
	"job" text PRIMARY KEY NOT NULL,
	"every_seconds" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text,
	"failures" integer DEFAULT 0 NOT NULL
);
