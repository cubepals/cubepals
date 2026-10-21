// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Collection;
import java.util.UUID;

/**
 * The events the reporter sends, written as the control plane reads them (`ServerJoinEvent` in
 * packages/contracts/src/join-records.ts): a kind, when, and what the server knew of the player.
 * Pure, so its tests need no server.
 */
final class Events {
    private static final DateTimeFormatter AT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    private Events() {}

    /** A moment in ISO 8601, in UTC, with milliseconds. */
    static String at(Instant instant) {
        return AT.format(instant);
    }

    /** A client's `ip:port`, an IPv6 address in brackets; null where there is none. */
    static String address(InetSocketAddress socket) {
        if (socket == null || socket.getAddress() == null) return null;
        String ip = socket.getAddress().getHostAddress();
        return (ip.contains(":") ? "[" + ip + "]" : ip) + ":" + socket.getPort();
    }

    /** One event: `kind` at `at`, with whichever of the player's uuid, name and address are known. */
    static JsonObject event(String kind, Instant at, UUID uuid, String name, String address) {
        JsonObject event = new JsonObject();
        event.addProperty("kind", kind);
        event.addProperty("at", at(at));
        if (uuid != null) event.addProperty("uuid", uuid.toString());
        if (name != null) event.addProperty("name", name);
        if (address != null) event.addProperty("address", address);
        return event;
    }

    /** Stop cheaters removed a player, for `reason`: `movement`, `speed` or `impossible`. */
    static JsonObject removed(Instant at, UUID uuid, String name, String reason) {
        JsonObject event = event("removed", at, uuid, name, null);
        event.addProperty("reason", reason);
        return event;
    }

    /** How the server ticked as a player came into the world. */
    static JsonObject tick(double tps, double mspt, int online) {
        JsonObject tick = new JsonObject();
        tick.addProperty("tps", Math.round(tps * 100) / 100.0);
        tick.addProperty("mspt", Math.round(mspt * 100) / 100.0);
        tick.addProperty("online", online);
        return tick;
    }

    /**
     * The server as it booted: its Paper, and the plugins listening as players log in, which slow
     * every join where they do work there.
     */
    static JsonObject boot(
            Instant at, String paper, String minecraft, Collection<String> onLogin, Collection<String> onConfigure) {
        JsonObject detail = new JsonObject();
        detail.addProperty("paper", paper);
        detail.addProperty("minecraft", minecraft);
        detail.add("loginListeners", strings(onLogin));
        detail.add("configureListeners", strings(onConfigure));
        JsonObject event = event("boot", at, null, null, null);
        event.add("detail", detail);
        return event;
    }

    /** A batch, as the control plane takes it. */
    static String batch(Collection<JsonObject> events) {
        JsonArray array = new JsonArray();
        for (JsonObject event : events) array.add(event);
        JsonObject batch = new JsonObject();
        batch.add("events", array);
        return batch.toString();
    }

    private static JsonArray strings(Collection<String> values) {
        JsonArray array = new JsonArray();
        for (String value : values) array.add(value);
        return array;
    }
}
