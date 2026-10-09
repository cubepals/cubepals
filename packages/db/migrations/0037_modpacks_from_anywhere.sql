CREATE TYPE "public"."pack_import_status" AS ENUM('reading', 'ready', 'refused');--> statement-breakpoint
ALTER TYPE "public"."artifact_source" ADD VALUE 'built';--> statement-breakpoint
ALTER TYPE "public"."upload_kind" ADD VALUE 'pack';--> statement-breakpoint
CREATE TABLE "pack_contents" (
	"sha512" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version_label" text NOT NULL,
	"game_version" text NOT NULL,
	"loader" "loader" NOT NULL,
	"loader_version" text,
	"players_need_it" boolean NOT NULL,
	"jars" jsonb NOT NULL,
	"left_out" jsonb NOT NULL,
	"memory_mb" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"status" "pack_import_status" DEFAULT 'reading' NOT NULL,
	"pack_sha512" text,
	"result" jsonb,
	"refusal" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pending_uploads" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pack_imports" ADD CONSTRAINT "pack_imports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_imports" ADD CONSTRAINT "pack_imports_pack_sha512_stored_artifacts_sha512_fk" FOREIGN KEY ("pack_sha512") REFERENCES "public"."stored_artifacts"("sha512") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pack_imports_owner" ON "pack_imports" USING btree ("owner_id","created_at");