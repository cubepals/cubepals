// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import org.bukkit.Bukkit;
import org.bukkit.event.HandlerList;
import org.bukkit.event.player.PlayerLoginEvent;
import org.bukkit.plugin.RegisteredListener;
import org.bukkit.plugin.java.JavaPlugin;

/**
 * The plugin Cubepals places on Paper servers so each join can be followed from the edge into the
 * world: it reports the server's own steps of each join to the control plane, at
 * `CUBEPALS_REPORT_URL`. With no such address it does nothing at all.
 */
public final class Reporter extends JavaPlugin {
    private static final String CONFIGURE =
            "io.papermc.paper.event.connection.configuration.AsyncPlayerConnectionConfigureEvent";

    private Queue queue;

    @Override
    public void onEnable() {
        String url = System.getenv("CUBEPALS_REPORT_URL");
        if (url == null || url.isBlank()) return;
        queue = new Queue(Queue.http(URI.create(url)), Duration.ofSeconds(1));
        queue.start();
        new Listeners(queue::offer).register(this);
        // Once every plugin is enabled, so the listeners named are all there.
        Bukkit.getScheduler().runTask(this, () -> queue.offer(Events.boot(
                Instant.now(),
                Bukkit.getVersion(),
                Bukkit.getMinecraftVersion(),
                listening(PlayerLoginEvent.getHandlerList()),
                listening(handlersOf(CONFIGURE)))));
    }

    @Override
    public void onDisable() {
        if (queue != null) queue.stop(Duration.ofSeconds(2));
    }

    /** The plugins, other than this one, with a listener on `handlers`, by name. */
    private List<String> listening(HandlerList handlers) {
        if (handlers == null) return List.of();
        TreeSet<String> names = new TreeSet<>();
        for (RegisteredListener listener : handlers.getRegisteredListeners())
            if (listener.getPlugin() != this) names.add(listener.getPlugin().getName());
        return new ArrayList<>(names);
    }

    /** An event class's handlers, by its name; null where this Paper has no such event. */
    private static HandlerList handlersOf(String className) {
        Class<?> type = Listeners.classNamed(className);
        if (type == null) return null;
        try {
            return (HandlerList) type.getMethod("getHandlerList").invoke(null);
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }
}
