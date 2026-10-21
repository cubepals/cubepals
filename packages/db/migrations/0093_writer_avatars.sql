-- Each note writer keeps the picture style they were first given, whatever the styles on offer later.
CREATE TABLE "writer_avatars" (
	"user_id" text PRIMARY KEY NOT NULL,
	"style" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "writer_avatars" ADD CONSTRAINT "writer_avatars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;