ALTER TABLE "backups" DROP CONSTRAINT "backups_handle_by_tier";--> statement-breakpoint
ALTER TABLE "backups" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_handle_only_on_snapshots" CHECK ("backups"."tier" = 'snapshot' or "backups"."snapshot_handle" is null);--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_ready_snapshot_has_handle" CHECK ("backups"."tier" <> 'snapshot' or "backups"."status" in ('failed', 'deleted') or "backups"."snapshot_handle" is not null);