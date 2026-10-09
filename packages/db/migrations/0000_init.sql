CREATE TYPE "public"."access_entry_state" AS ENUM('active', 'pending_add', 'pending_remove', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."access_list" AS ENUM('whitelist', 'operator', 'ban');--> statement-breakpoint
CREATE TYPE "public"."access_origin" AS ENUM('blockly', 'game');--> statement-breakpoint
CREATE TYPE "public"."account_status" AS ENUM('active', 'suspended', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."artifact_source" AS ENUM('upload', 'mirror');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'ready', 'failed', 'expired', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."backup_tier" AS ENUM('snapshot', 'archive');--> statement-breakpoint
CREATE TYPE "public"."backup_trigger" AS ENUM('scheduled', 'pre_apply', 'pre_restore', 'manual');--> statement-breakpoint
CREATE TYPE "public"."listing_moderation" AS ENUM('clear', 'removed');--> statement-breakpoint
CREATE TYPE "public"."listing_visibility" AS ENUM('draft', 'published', 'unpublished');--> statement-breakpoint
CREATE TYPE "public"."loader" AS ENUM('vanilla', 'paper', 'fabric', 'quilt', 'neoforge', 'forge');--> statement-breakpoint
CREATE TYPE "public"."operation_kind" AS ENUM('provision', 'start', 'stop', 'restart', 'apply', 'relocate', 'backup', 'archive', 'restore', 'access_sync', 'prune_worlds', 'decommission', 'purge');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."report_status" AS ENUM('open', 'dismissed', 'actioned');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('provisioning', 'stopped', 'starting', 'running', 'stopping', 'updating', 'restoring', 'relocating', 'failed', 'deleted', 'purged');--> statement-breakpoint
CREATE TYPE "public"."stop_reason" AS ENUM('user', 'idle', 'policy', 'entitlement', 'crash', 'maintenance');--> statement-breakpoint
CREATE TABLE "account_standing" (
	"user_id" text PRIMARY KEY NOT NULL,
	"status" "account_status" DEFAULT 'active' NOT NULL,
	"reason" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"restrictions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"limit_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"world_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"tier" "backup_tier" NOT NULL,
	"trigger" "backup_trigger" NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"snapshot_handle" text,
	"archive_key" text,
	"size_bytes" bigint,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backups_handle_by_tier" CHECK (("backups"."tier" = 'snapshot') = ("backups"."snapshot_handle" is not null))
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_customer_id" text NOT NULL,
	"external_subscription_id" text NOT NULL,
	"plan_key" text NOT NULL,
	"status" text NOT NULL,
	"current_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_projects" (
	"catalog" text NOT NULL,
	"project_id" text NOT NULL,
	"state" text NOT NULL,
	"absent_streak" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_projects_catalog_project_id_pk" PRIMARY KEY("catalog","project_id")
);
--> statement-breakpoint
CREATE TABLE "catalog_versions" (
	"catalog" text NOT NULL,
	"version_id" text NOT NULL,
	"project_id" text NOT NULL,
	"state" text NOT NULL,
	"absent_streak" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "catalog_versions_catalog_version_id_pk" PRIMARY KEY("catalog","version_id")
);
--> statement-breakpoint
CREATE TABLE "listing_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"reporter_id" text NOT NULL,
	"reason" text NOT NULL,
	"status" "report_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "minecraft_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"region_key" text NOT NULL,
	"memory_tier" text NOT NULL,
	"status" "server_status" NOT NULL,
	"stop_reason" "stop_reason",
	"failure" jsonb,
	"desired_revision_id" uuid,
	"active_world_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"create_idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"purge_after" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mod_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"sha512" text NOT NULL,
	"file_name" text NOT NULL,
	"loader_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_controls" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"provisioning_enabled" boolean DEFAULT true NOT NULL,
	"starts_enabled" boolean DEFAULT true NOT NULL,
	"public_listing_enabled" boolean DEFAULT true NOT NULL,
	"uploads_enabled" boolean DEFAULT true NOT NULL,
	"max_servers" integer DEFAULT 40 NOT NULL,
	"max_running_servers" integer DEFAULT 15 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_controls_singleton" CHECK ("platform_controls"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "power_intervals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"memory_tier" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "public_listings" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"visibility" "listing_visibility" DEFAULT 'draft' NOT NULL,
	"moderation" "listing_moderation" DEFAULT 'clear' NOT NULL,
	"moderation_note" text,
	"eligible" boolean DEFAULT false NOT NULL,
	"ineligible_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_revision_id" uuid,
	"evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retired_slugs" (
	"slug" text PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"retired_at" timestamp with time zone NOT NULL,
	"available_after" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_access" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"whitelist_enabled" boolean DEFAULT false NOT NULL,
	"whitelist_enabled_pending" boolean,
	"reseed_required" boolean DEFAULT true NOT NULL,
	"synced_at" timestamp with time zone,
	"sync_error" text,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_access_entries" (
	"server_id" uuid NOT NULL,
	"list" "access_list" NOT NULL,
	"player_uuid" uuid NOT NULL,
	"player_name" text NOT NULL,
	"state" "access_entry_state" NOT NULL,
	"origin" "access_origin" NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"requested_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_access_entries_server_id_list_player_uuid_pk" PRIMARY KEY("server_id","list","player_uuid")
);
--> statement-breakpoint
CREATE UNLOGGED TABLE "server_activity" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"last_player_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"kind" "operation_kind" NOT NULL,
	"status" "operation_status" DEFAULT 'queued' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"progress" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNLOGGED TABLE "server_presence" (
	"server_id" uuid NOT NULL,
	"player_uuid" uuid NOT NULL,
	"player_name" text NOT NULL,
	"source" text NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "server_presence_server_id_player_uuid_pk" PRIMARY KEY("server_id","player_uuid")
);
--> statement-breakpoint
CREATE TABLE "server_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"game_version" text NOT NULL,
	"loader" "loader" NOT NULL,
	"loader_version" text,
	"settings" jsonb NOT NULL,
	"mods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"based_on_revision_id" uuid,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_runtimes" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"handle" text,
	"placement_region_key" text,
	"applied" jsonb,
	"observed" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stored_artifacts" (
	"sha512" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"source" "artifact_source" NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusted_mod_projects" (
	"catalog" text NOT NULL,
	"project_id" text NOT NULL,
	"display_name" text NOT NULL,
	"added_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trusted_mod_projects_catalog_project_id_pk" PRIMARY KEY("catalog","project_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "worlds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"level_name" text NOT NULL,
	"seed" text,
	"level_type" text DEFAULT 'minecraft:normal' NOT NULL,
	"hardcore" boolean DEFAULT false NOT NULL,
	"generated_on_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_standing" ADD CONSTRAINT "account_standing_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_world_id_worlds_id_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_revision_id_server_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."server_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_reports" ADD CONSTRAINT "listing_reports_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_reports" ADD CONSTRAINT "listing_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD CONSTRAINT "minecraft_servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD CONSTRAINT "minecraft_servers_desired_revision_id_server_revisions_id_fk" FOREIGN KEY ("desired_revision_id") REFERENCES "public"."server_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "minecraft_servers" ADD CONSTRAINT "minecraft_servers_active_world_id_worlds_id_fk" FOREIGN KEY ("active_world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_uploads" ADD CONSTRAINT "mod_uploads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_uploads" ADD CONSTRAINT "mod_uploads_sha512_stored_artifacts_sha512_fk" FOREIGN KEY ("sha512") REFERENCES "public"."stored_artifacts"("sha512") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "power_intervals" ADD CONSTRAINT "power_intervals_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_listings" ADD CONSTRAINT "public_listings_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_access" ADD CONSTRAINT "server_access_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_access_entries" ADD CONSTRAINT "server_access_entries_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_operations" ADD CONSTRAINT "server_operations_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_revisions" ADD CONSTRAINT "server_revisions_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_runtimes" ADD CONSTRAINT "server_runtimes_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worlds" ADD CONSTRAINT "worlds_server_id_minecraft_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."minecraft_servers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_subject" ON "audit_log" USING btree ("subject_type","subject_id","at");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "backups_server_recent" ON "backups" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_external" ON "billing_subscriptions" USING btree ("provider","external_subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user" ON "billing_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "listing_reports_open" ON "listing_reports" USING btree ("created_at") WHERE "listing_reports"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "servers_slug_live" ON "minecraft_servers" USING btree ("slug") WHERE "minecraft_servers"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "servers_create_idem" ON "minecraft_servers" USING btree ("owner_id","create_idempotency_key");--> statement-breakpoint
CREATE INDEX "servers_owner_live" ON "minecraft_servers" USING btree ("owner_id") WHERE "minecraft_servers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "power_intervals_server" ON "power_intervals" USING btree ("server_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "power_intervals_one_open" ON "power_intervals" USING btree ("server_id") WHERE "power_intervals"."stopped_at" is null;--> statement-breakpoint
CREATE INDEX "listings_browse" ON "public_listings" USING btree ("updated_at") WHERE "public_listings"."visibility" = 'published' and "public_listings"."moderation" = 'clear' and "public_listings"."eligible";--> statement-breakpoint
CREATE UNIQUE INDEX "operations_idem" ON "server_operations" USING btree ("server_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "operations_server_recent" ON "server_operations" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_server_number" ON "server_revisions" USING btree ("server_id","number");--> statement-breakpoint
CREATE INDEX "revisions_mods_gin" ON "server_revisions" USING gin ("mods" jsonb_path_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "worlds_server_level" ON "worlds" USING btree ("server_id","level_name");--> statement-breakpoint
INSERT INTO "platform_controls" ("id") VALUES (1) ON CONFLICT DO NOTHING;
