-- What ran slow or failed in the control plane, with the account, server and request it ran for.
-- Kept 14 days (app/diagnostics/).
CREATE TABLE "diagnostics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"ms" real NOT NULL,
	"error" text,
	"origin" text NOT NULL,
	"role" text NOT NULL,
	"account_id" text,
	"server_id" uuid,
	"request_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "diagnostics_at" ON "diagnostics" USING btree ("at");--> statement-breakpoint
CREATE INDEX "diagnostics_account" ON "diagnostics" USING btree ("account_id","at") WHERE "diagnostics"."account_id" is not null;--> statement-breakpoint
CREATE INDEX "diagnostics_server" ON "diagnostics" USING btree ("server_id","at") WHERE "diagnostics"."server_id" is not null;--> statement-breakpoint
CREATE INDEX "diagnostics_name" ON "diagnostics" USING btree ("kind","name","at");