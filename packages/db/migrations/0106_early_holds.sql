CREATE TABLE "early_holds" (
	"user_id" text PRIMARY KEY NOT NULL,
	"plan_key" text NOT NULL,
	"product_id" text NOT NULL,
	"points" integer NOT NULL,
	"price_cents" integer NOT NULL,
	"included_units" integer NOT NULL,
	"most_extra_units" integer,
	"expires_at" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "early_holds" ADD CONSTRAINT "early_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;