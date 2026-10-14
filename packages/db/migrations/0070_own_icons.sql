CREATE TABLE "server_icons" (
	"server_id" uuid NOT NULL,
	"sha256" text NOT NULL,
	"png" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_icons_server_id_sha256_pk" PRIMARY KEY("server_id","sha256")
);
--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD COLUMN "own_icon" text;--> statement-breakpoint
ALTER TABLE "server_icons" ADD CONSTRAINT "server_icons_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;