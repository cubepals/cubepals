ALTER TABLE "realtime_certificate" ADD COLUMN "hostname" text;--> statement-breakpoint
ALTER TABLE "realtime_certificate" ADD COLUMN "certificate_pem" text;--> statement-breakpoint
ALTER TABLE "realtime_certificate" ADD COLUMN "private_key_sealed" text;--> statement-breakpoint
ALTER TABLE "realtime_certificate" ADD COLUMN "issued_at" timestamp with time zone;