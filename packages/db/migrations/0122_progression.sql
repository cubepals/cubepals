CREATE TABLE "server_progression_off" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_progression_parts" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"furnaces" boolean DEFAULT true NOT NULL,
	"plants" boolean DEFAULT true NOT NULL,
	"animals" boolean DEFAULT true NOT NULL,
	"world" boolean DEFAULT true NOT NULL,
	"fire" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_progression_off" ADD CONSTRAINT "server_progression_off_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_progression_parts" ADD CONSTRAINT "server_progression_parts_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;