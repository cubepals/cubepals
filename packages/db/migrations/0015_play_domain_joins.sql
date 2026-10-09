CREATE TABLE "play_domain_joins" (
	"domain" text PRIMARY KEY NOT NULL,
	"joins" integer DEFAULT 0 NOT NULL,
	"last_join_at" timestamp with time zone NOT NULL
);
