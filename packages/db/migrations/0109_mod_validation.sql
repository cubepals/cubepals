CREATE TABLE "mod_compilations" (
	"key" text PRIMARY KEY NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_validation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mod_validations" (
	"key" text PRIMARY KEY NOT NULL,
	"plan" jsonb NOT NULL,
	"state" text DEFAULT 'checking' NOT NULL,
	"runtime_id" uuid NOT NULL,
	"handle" text,
	"lease_until" timestamp with time zone,
	"message" text,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "catalog_version_needs" ADD COLUMN "file_sha512" text;--> statement-breakpoint
ALTER TABLE "catalog_version_needs" ADD COLUMN "native_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "mod_validation_runs" ADD CONSTRAINT "mod_validation_runs_key_mod_validations_key_fk" FOREIGN KEY ("key") REFERENCES "public"."mod_validations"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mod_validation_runs_key" ON "mod_validation_runs" USING btree ("key");--> statement-breakpoint
CREATE INDEX "mod_validations_runtime" ON "mod_validations" USING btree ("runtime_id");