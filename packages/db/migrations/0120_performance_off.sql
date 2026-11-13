CREATE TABLE "server_performance_off" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_performance_off" ADD CONSTRAINT "server_performance_off_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;