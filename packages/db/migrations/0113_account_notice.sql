CREATE TABLE "notice_said" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"notice_set_at" timestamp with time zone NOT NULL,
	"players" text[] DEFAULT '{}'::text[] NOT NULL,
	"said_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "notice" text;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "notice_set_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "notice_set_by" text;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "notice_limit_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_standing" ADD COLUMN "notice_limited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notice_said" ADD CONSTRAINT "notice_said_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_standing_notice_due" ON "account_standing" USING btree ("notice_limit_at") WHERE "account_standing"."notice" is not null and "account_standing"."notice_limited_at" is null;--> statement-breakpoint
ALTER TABLE "account_standing" ADD CONSTRAINT "account_standing_notice_set" CHECK ("account_standing"."notice" is null or ("account_standing"."notice_set_at" is not null and "account_standing"."notice_set_by" is not null));