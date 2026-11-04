CREATE TABLE "server_vitals" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"tps" real NOT NULL,
	"mspt" real NOT NULL,
	"mspt_p95" real NOT NULL,
	"mspt_max" real NOT NULL,
	"players" integer NOT NULL,
	"chunks" integer NOT NULL,
	"entities" integer NOT NULL,
	"heap_used_mb" integer NOT NULL,
	"heap_max_mb" integer NOT NULL,
	"gc_ms" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_vitals" ADD CONSTRAINT "server_vitals_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_vitals_once" ON "server_vitals" USING btree ("server_id","at");--> statement-breakpoint
CREATE INDEX "server_vitals_at" ON "server_vitals" USING btree ("at");