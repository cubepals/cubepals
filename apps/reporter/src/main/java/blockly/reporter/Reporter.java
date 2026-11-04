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
 * `CUBEPALS_REPORT_URL`, and how the server ticks, once a minute, at `CUBEPALS_VITALS_URL`
 * (`Vitals`). It also gives Stop cheaters its console command, `cubepals-remove` (`Removals`),
 * which kicks a player and reports it. With no address it only kicks.
 */
public final class Reporter extends JavaPlugin {
    private static final String CONFIGURE =
            "io.papermc.paper.event.connection.configuration.AsyncPlayerConnectionConfigureEvent";

    private Queue queue;
    private Queue vitals;

    @Override
    public void onEnable() {
        startVitals();
        String url = System.getenv("CUBEPALS_REPORT_URL");
        boolean reports = url != null && !url.isBlank();
        if (reports) queue = new Queue(Queue.http(URI.create(url)), Duration.ofSeconds(1));
        var remove = getCommand("cubepals-remove");
        if (remove != null) remove.setExecutor(new Removals(reports ? queue::offer : null));
        if (!reports) return;
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
        if (vitals != null) vitals.stop(Duration.ofSeconds(1));
    }

    /**
     * Samples how the server ticks once a minute (`Vitals`) and sends it to `CUBEPALS_VITALS_URL`
     * from a queue of its own, so a join's report never waits behind it. Without the address, nothing.
     */
    private void startVitals() {
        String url = System.getenv("CUBEPALS_VITALS_URL");
        if (url == null || url.isBlank()) return;
        vitals = new Queue(Queue.http(URI.create(url)), Duration.ofSeconds(5));
        vitals.start();
        Bukkit.getScheduler().runTaskTimer(this, new Vitals(vitals::offer), Vitals.EVERY_TICKS, Vitals.EVERY_TICKS);
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
