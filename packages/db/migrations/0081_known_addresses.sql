CREATE TABLE "known_addresses" (
	"server_id" uuid NOT NULL,
	"address" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "known_addresses_server_id_address_pk" PRIMARY KEY("server_id","address")
);
--> statement-breakpoint
ALTER TABLE "known_addresses" ADD CONSTRAINT "known_addresses_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "known_addresses_seen" ON "known_addresses" USING btree ("seen_at");