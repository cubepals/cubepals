-- Worlds the server lists that are kept only in a backup, and one backup per file in the store.
CREATE TABLE "kept_worlds" (
	"world_id" uuid PRIMARY KEY NOT NULL,
	"backup_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "kept_worlds" ADD CONSTRAINT "kept_worlds_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kept_worlds" ADD CONSTRAINT "kept_worlds_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Where two backups share a file, the one that stays keeps it; the other lets go of the key, so
-- erasing it never takes the file from under the one that stays.
WITH ranked AS (
	SELECT "id", "status", row_number() OVER (
		PARTITION BY "archive_key"
		ORDER BY ("status" = 'ready') DESC, "created_at", "id"
	) AS "n"
	FROM "backups"
	WHERE "archive_key" IS NOT NULL
)
UPDATE "backups" SET
	"archive_key" = NULL,
	"status" = CASE WHEN ranked."status" = 'ready' THEN 'deleted'::"backup_status" ELSE ranked."status" END
FROM ranked
WHERE "backups"."id" = ranked."id" AND ranked."n" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "backups_one_per_archive_key" ON "backups" USING btree ("archive_key") WHERE "backups"."archive_key" is not null;