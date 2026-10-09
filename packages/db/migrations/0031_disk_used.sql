ALTER TABLE "server_runtimes" ADD COLUMN "storage_gb" integer;--> statement-breakpoint
ALTER TABLE "server_runtimes" ADD COLUMN "disk_used_bytes" bigint;--> statement-breakpoint
ALTER TABLE "server_runtimes" ADD COLUMN "disk_checked_at" timestamp with time zone;