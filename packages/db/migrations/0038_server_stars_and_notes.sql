CREATE TABLE "server_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_notes_body_length" CHECK (char_length("server_notes"."body") between 1 and 128)
);
--> statement-breakpoint
CREATE TABLE "server_stars" (
	"server_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_stars_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "server_notes" ADD CONSTRAINT "server_notes_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_notes" ADD CONSTRAINT "server_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_stars" ADD CONSTRAINT "server_stars_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_stars" ADD CONSTRAINT "server_stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_notes_server" ON "server_notes" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX "server_notes_author" ON "server_notes" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "server_stars_user" ON "server_stars" USING btree ("user_id");