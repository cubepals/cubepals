CREATE TABLE "realtime_certificate" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "realtime_certificate_singleton" CHECK ("realtime_certificate"."id" = 1)
);
