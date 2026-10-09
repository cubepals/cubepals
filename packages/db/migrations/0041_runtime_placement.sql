CREATE TYPE "public"."runtime_decision_kind" AS ENUM('placed', 'fell_back', 'move_requested', 'move_cancelled', 'moved', 'move_failed');--> statement-breakpoint
CREATE TABLE "runtime_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" "runtime_decision_kind" NOT NULL,
	"provider" text NOT NULL,
	"from_provider" text,
	"rule_id" uuid,
	"reason" text NOT NULL,
	"considered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"percent" integer NOT NULL,
	"accounts" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"plans" text[] DEFAULT '{}'::text[] NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_rules_percent" CHECK ("runtime_rules"."percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "server_usage_days" (
	"server_id" uuid NOT NULL,
	"day" date NOT NULL,
	"provider" text NOT NULL,
	"player_minutes" integer DEFAULT 0 NOT NULL,
	"active_minutes" integer DEFAULT 0 NOT NULL,
	"peak_players" integer DEFAULT 0 NOT NULL,
	"last_sample_at" timestamp with time zone NOT NULL,
	CONSTRAINT "server_usage_days_server_id_day_provider_pk" PRIMARY KEY("server_id","day","provider")
);
--> statement-breakpoint
ALTER TABLE "power_intervals" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "server_runtimes" ADD COLUMN "move_to" text;--> statement-breakpoint
ALTER TABLE "runtime_decisions" ADD CONSTRAINT "runtime_decisions_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_decisions" ADD CONSTRAINT "runtime_decisions_rule_id_runtime_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."runtime_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_usage_days" ADD CONSTRAINT "server_usage_days_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runtime_decisions_server" ON "runtime_decisions" USING btree ("server_id","at");--> statement-breakpoint
CREATE INDEX "runtime_decisions_at" ON "runtime_decisions" USING btree ("at");--> statement-breakpoint
CREATE INDEX "server_usage_days_day" ON "server_usage_days" USING btree ("day");