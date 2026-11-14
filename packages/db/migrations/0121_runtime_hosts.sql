CREATE TABLE "runtime_hosts" (
	"provider" text NOT NULL,
	"region" text NOT NULL,
	"host" text NOT NULL,
	"model" text,
	"mhz" real NOT NULL,
	"mhz_min" real NOT NULL,
	"mhz_max" real NOT NULL,
	"readings" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtime_hosts_provider_region_host_pk" PRIMARY KEY("provider","region","host")
);
