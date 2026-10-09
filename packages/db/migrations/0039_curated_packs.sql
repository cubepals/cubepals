CREATE TYPE "public"."curated_release_state" AS ENUM('pending', 'verified', 'published', 'withdrawn', 'refused');--> statement-breakpoint
ALTER TYPE "public"."artifact_source" ADD VALUE 'curated';--> statement-breakpoint
CREATE TABLE "curated_releases" (
	"pack_key" text NOT NULL,
	"version" text NOT NULL,
	"state" "curated_release_state" DEFAULT 'pending' NOT NULL,
	"distribution" text,
	"pack" jsonb,
	"facts" jsonb,
	"refusal" text,
	"detail" text,
	"withdrawn_reason" text,
	"changed_by" text DEFAULT 'system:curation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curated_releases_pack_key_version_pk" PRIMARY KEY("pack_key","version"),
	CONSTRAINT "curated_releases_checked" CHECK ("curated_releases"."state" in ('pending', 'refused') or ("curated_releases"."pack" is not null and "curated_releases"."facts" is not null and "curated_releases"."distribution" is not null))
);
