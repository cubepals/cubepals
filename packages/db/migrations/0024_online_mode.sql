-- Every server so far has verified players with Minecraft's account servers: the setting existed
-- only as a constant. It becomes part of each revision's settings, true for all of them.
UPDATE "server_revisions" SET "settings" = "settings" || '{"onlineMode": true}'::jsonb WHERE NOT ("settings" ? 'onlineMode');
