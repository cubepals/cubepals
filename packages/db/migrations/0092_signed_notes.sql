-- Notes already there were written as anonymous, so they are added unsigned; every note after this is signed.
ALTER TABLE "server_notes" ADD COLUMN "signed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "server_notes" ALTER COLUMN "signed" SET DEFAULT true;
