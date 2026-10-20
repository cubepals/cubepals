// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.UUID;
import java.util.function.Consumer;
import org.bukkit.Bukkit;
import org.bukkit.entity.Player;
import org.bukkit.event.Event;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.plugin.Plugin;

/**
 * Each step of a player's join as the server sees it, queued as it happens: the login, the start
 * and end of configuration (Paper 1.21.7 and newer, found by name so older Paper loads this), in
 * the world, and leaving. Every handler runs last (`MONITOR`) and only reads: it changes nothing
 * about the join, and it never listens on `PlayerLoginEvent`, which slows every login.
 */
final class Listeners implements Listener {
    static final String INITIAL_CONFIGURE =
            "io.papermc.paper.event.connection.configuration.PlayerConnectionInitialConfigureEvent";
    static final String VALIDATE_LOGIN = "io.papermc.paper.event.connection.PlayerConnectionValidateLoginEvent";
    private static final String CONFIGURATION_CONNECTION = "io.papermc.paper.connection.PlayerConfigurationConnection";

    private final Consumer<com.google.gson.JsonObject> queue;

    Listeners(Consumer<com.google.gson.JsonObject> queue) {
        this.queue = queue;
    }

    /** Registers every handler, and the configuration events where this Paper has them. */
    void register(Plugin plugin) {
        Bukkit.getPluginManager().registerEvents(this, plugin);
        byName(plugin, INITIAL_CONFIGURE, event -> configuration(event, "configure_started"));
        // Fired once as the login is checked and again once configuration is over: the second is ours.
        byName(plugin, VALIDATE_LOGIN, event -> configuration(event, "configured"));
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void login(AsyncPlayerPreLoginEvent event) {
        // This event knows the address without its port, which can't name the connection: the
        // control plane matches it by the player instead.
        queue.accept(Events.event("login", Instant.now(), event.getUniqueId(), event.getName(), null));
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void inWorld(PlayerJoinEvent event) {
        Player player = event.getPlayer();
        var in = Events.event(
                "in_world", Instant.now(), player.getUniqueId(), player.getName(), Events.address(player.getAddress()));
        in.add("tick", Events.tick(Bukkit.getTPS()[0], Bukkit.getAverageTickTime(), Bukkit.getOnlinePlayers().size()));
        queue.accept(in);
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = false)
    public void left(PlayerQuitEvent event) {
        Player player = event.getPlayer();
        var left = Events.event(
                "left", Instant.now(), player.getUniqueId(), player.getName(), Events.address(player.getAddress()));
        left.addProperty("reason", event.getReason().name().toLowerCase(java.util.Locale.ROOT));
        queue.accept(left);
    }

    /** A configuration event: its player's profile and address, read by name. */
    void configuration(Object event, String kind) {
        Object connection = call(event, "getConnection");
        if (connection == null || !isA(connection, CONFIGURATION_CONNECTION)) return;
        Object profile = call(connection, "getProfile");
        Object id = profile == null ? null : call(profile, "getId");
        Object name = profile == null ? null : call(profile, "getName");
        Object address = call(connection, "getClientAddress");
        queue.accept(Events.event(
                kind,
                Instant.now(),
                id instanceof UUID uuid ? uuid : null,
                name instanceof String text ? text : null,
                address instanceof InetSocketAddress socket ? Events.address(socket) : null));
    }

    /** Listens on the event class named `className`, where this Paper has one. */
    @SuppressWarnings("unchecked")
    private void byName(Plugin plugin, String className, Consumer<Object> handler) {
        Class<?> type = classNamed(className);
        if (type == null || !Event.class.isAssignableFrom(type)) return;
        Bukkit.getPluginManager()
                .registerEvent(
                        (Class<? extends Event>) type,
                        this,
                        EventPriority.MONITOR,
                        (listener, event) -> {
                            if (type.isInstance(event)) handler.accept(event);
                        },
                        plugin,
                        false);
    }

    static Class<?> classNamed(String name) {
        try {
            return Class.forName(name);
        } catch (ClassNotFoundException e) {
            return null;
        }
    }

    private static boolean isA(Object value, String className) {
        Class<?> type = classNamed(className);
        return type != null && type.isInstance(value);
    }

    /** `target.method()`, or null when it has none or it fails: a report is never worth a crash. */
    static Object call(Object target, String method) {
        try {
            Method found = target.getClass().getMethod(method);
            found.setAccessible(true);
            return found.invoke(target);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }
}
