CREATE TYPE "public"."jar_check_state" AS ENUM('checking', 'clean', 'flagged', 'quarantined');--> statement-breakpoint
CREATE TABLE "jar_checks" (
	"sha512" text PRIMARY KEY NOT NULL,
	"sha256" text,
	"sha1" text,
	"state" "jar_check_state" DEFAULT 'checking' NOT NULL,
	"finding" jsonb,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"released_by" text,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "malware_signatures" (
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"family" text,
	CONSTRAINT "malware_signatures_source_kind_value_pk" PRIMARY KEY("source","kind","value")
);
--> statement-breakpoint
CREATE TABLE "malware_sources" (
	"source" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"digest" text NOT NULL,
	"entries" integer NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jar_checks_state" ON "jar_checks" USING btree ("state");--> statement-breakpoint
CREATE INDEX "malware_signatures_value" ON "malware_signatures" USING btree ("kind","value");