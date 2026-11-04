ALTER TABLE "server_vitals" ALTER COLUMN "chunks" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server_vitals" ALTER COLUMN "entities" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server_vitals" ALTER COLUMN "heap_used_mb" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server_vitals" ALTER COLUMN "heap_max_mb" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server_vitals" ALTER COLUMN "gc_ms" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "server_vitals" ADD COLUMN "source" text DEFAULT 'reporter' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_vitals" ADD CONSTRAINT "server_vitals_source" CHECK ("server_vitals"."source" in ('reporter', 'console'));