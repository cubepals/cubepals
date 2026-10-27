CREATE TYPE "public"."world_import_status" AS ENUM('reading', 'asking', 'ready', 'refused');--> statement-breakpoint
CREATE TABLE "world_imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"server_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"name" text,
	"status" "world_import_status" DEFAULT 'reading' NOT NULL,
	"question" jsonb,
	"answer" jsonb,
	"backup_id" uuid,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"refusal" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "world_imports" ADD CONSTRAINT "world_imports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_imports" ADD CONSTRAINT "world_imports_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "world_imports" ADD CONSTRAINT "world_imports_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "world_imports_server" ON "world_imports" USING btree ("server_id","created_at");