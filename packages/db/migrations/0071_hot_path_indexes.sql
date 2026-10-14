CREATE INDEX "backups_ready_expiry" ON "backups" USING btree ("expires_at") WHERE "backups"."status" = 'ready';--> statement-breakpoint
CREATE INDEX "servers_status" ON "minecraft_servers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "servers_slug_deleted" ON "minecraft_servers" USING btree ("slug") WHERE "minecraft_servers"."status" = 'deleted';--> statement-breakpoint
CREATE INDEX "operations_server_kind" ON "server_operations" USING btree ("server_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "server_players_confirmed" ON "server_players" USING btree ("confirmed_at");