CREATE TABLE "insight_asks" (
	"user_id" text NOT NULL,
	"moment" text NOT NULL,
	"detail" jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"shown_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "insight_asks_user_id_moment_pk" PRIMARY KEY("user_id","moment")
);
--> statement-breakpoint
CREATE TABLE "insight_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "insight_events_once" ON "insight_events" USING btree ("event","subject");--> statement-breakpoint
CREATE INDEX "insight_events_unsent" ON "insight_events" USING btree ("at") WHERE "insight_events"."sent_at" is null;