ALTER TABLE "world_imports" ALTER COLUMN "server_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "world_imports" ADD COLUMN "facts" jsonb;--> statement-breakpoint
ALTER TABLE "world_imports" ADD COLUMN "starts_on" jsonb;--> statement-breakpoint
ALTER TABLE "worlds" ADD COLUMN "starts_on" jsonb;--> statement-breakpoint
CREATE INDEX "world_imports_owner" ON "world_imports" USING btree ("owner_id","created_at");