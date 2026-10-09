CREATE TABLE "billing_orders" (
	"provider" text NOT NULL,
	"external_order_id" text NOT NULL,
	"user_id" text NOT NULL,
	"plan_key" text,
	"billing_reason" text NOT NULL,
	"currency" text NOT NULL,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer NOT NULL,
	"net_cents" integer NOT NULL,
	"tax_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_orders_provider_external_order_id_pk" PRIMARY KEY("provider","external_order_id")
);
--> statement-breakpoint
ALTER TABLE "billing_orders" ADD CONSTRAINT "billing_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_orders_user" ON "billing_orders" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "billing_orders_ordered" ON "billing_orders" USING btree ("ordered_at");