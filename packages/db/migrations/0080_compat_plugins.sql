CREATE TABLE "compat_plugins" (
	"game_version" text NOT NULL,
	"project_id" text NOT NULL,
	"pinned" jsonb NOT NULL,
	"pinned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "compat_plugins_game_version_project_id_pk" PRIMARY KEY("game_version","project_id")
);
