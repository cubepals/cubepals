CREATE TABLE "pack_checks" (
	"catalog" text NOT NULL,
	"project_id" text NOT NULL,
	"refusal" text,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pack_checks_catalog_project_id_pk" PRIMARY KEY("catalog","project_id")
);
