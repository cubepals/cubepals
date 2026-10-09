CREATE TABLE "platform_alerts" (
	"key" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"raised_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"cleared_at" timestamp with time zone
);
