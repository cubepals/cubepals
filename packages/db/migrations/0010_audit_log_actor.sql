CREATE INDEX "audit_log_actor" ON "audit_log" USING btree ("actor","action","at");--> statement-breakpoint
CREATE INDEX "audit_log_at" ON "audit_log" USING btree ("at");