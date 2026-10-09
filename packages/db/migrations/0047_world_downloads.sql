CREATE TABLE "world_downloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_id" uuid NOT NULL,
	"key" text NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"size_bytes" bigint,
	"error" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "world_downloads" ADD CONSTRAINT "world_downloads_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "world_downloads_one_live" ON "world_downloads" USING btree ("backup_id") WHERE "world_downloads"."status" in ('pending', 'ready');