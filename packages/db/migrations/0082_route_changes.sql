-- Every write to what the edge's routes are read from announces itself on `blockly_routes`, so a
-- control plane holding LISTEN knows when its last read may be out of date (app/edge/inputs.ts).
-- Postgres folds the same notification sent many times in one transaction into one, sent at commit.
CREATE FUNCTION "blockly_routes_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('blockly_routes', '');
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "routes_changed" AFTER INSERT OR UPDATE OR DELETE ON "minecraft_servers" FOR EACH ROW EXECUTE FUNCTION "blockly_routes_changed"();--> statement-breakpoint
CREATE TRIGGER "routes_changed" AFTER INSERT OR UPDATE OR DELETE ON "server_runtimes" FOR EACH ROW EXECUTE FUNCTION "blockly_routes_changed"();--> statement-breakpoint
CREATE TRIGGER "routes_changed" AFTER INSERT OR UPDATE OR DELETE ON "server_operations" FOR EACH ROW EXECUTE FUNCTION "blockly_routes_changed"();--> statement-breakpoint
CREATE TRIGGER "routes_changed" AFTER INSERT OR UPDATE OR DELETE ON "power_intervals" FOR EACH ROW EXECUTE FUNCTION "blockly_routes_changed"();--> statement-breakpoint
CREATE TRIGGER "routes_changed" AFTER INSERT OR UPDATE OR DELETE ON "account_standing" FOR EACH ROW EXECUTE FUNCTION "blockly_routes_changed"();--> statement-breakpoint
CREATE TRIGGER "routes_changed" AFTER INSERT OR UPDATE OR DELETE ON "compat_plugins" FOR EACH ROW EXECUTE FUNCTION "blockly_routes_changed"();
