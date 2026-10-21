-- The signals job reads every join of the last few minutes, whatever its server or player.
CREATE INDEX "joins_connected" ON "joins" USING btree ("connected_at");