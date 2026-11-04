// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.reporter;

import com.google.gson.JsonObject;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import org.bukkit.Bukkit;
import org.bukkit.World;

/**
 * How the server is ticking, sampled once a minute of the clock on its main thread and queued for
 * the control plane at `CUBEPALS_VITALS_URL`: ticks a second, milliseconds a tick (the average, the 95th
 * percentile and the slowest of the last hundred), players, loaded chunks and entities, the JVM's
 * heap, and how long garbage collection paused it since the last sample. Reading them is a few
 * counters Paper already keeps; nothing here walks the world.
 *
 * Not for a join's own tick, which rides its `in_world` event (`Listeners`).
 */
final class Vitals implements Runnable {
    /**
     * Between samples, by the clock: a server that lags runs its ticks slower, so a count of ticks
     * would sample it less often the worse it plays.
     */
    static final Duration EVERY = Duration.ofMinutes(1);

    private final Consumer<JsonObject> queue;
    private final AtomicBoolean waiting = new AtomicBoolean(false);
    private long gcMsBefore = gcMs();

    Vitals(Consumer<JsonObject> queue) {
        this.queue = queue;
    }

    /**
     * What the clock runs each minute: hands a sample to the main thread through `dispatch`, unless
     * the last one handed over hasn't run yet, as on a server stalled for that long.
     */
    Runnable onTheMinute(Consumer<Runnable> dispatch) {
        return () -> {
            if (!waiting.compareAndSet(false, true)) return;
            try {
                dispatch.accept(() -> {
                    try {
                        run();
                    } finally {
                        waiting.set(false);
                    }
                });
            } catch (RuntimeException e) {
                // The plugin is being disabled: nothing more to sample.
                waiting.set(false);
            }
        };
    }

    @Override
    public void run() {
        long[] ticks = Bukkit.getTickTimes();
        double[] tps = Bukkit.getTPS();
        int chunks = 0;
        int entities = 0;
        for (World world : Bukkit.getWorlds()) {
            chunks += world.getChunkCount();
            entities += world.getEntityCount();
        }
        Runtime runtime = Runtime.getRuntime();
        long gc = gcMs();
        queue.accept(Events.vitals(
                Instant.now(),
                tps.length > 0 ? tps[0] : 0,
                Bukkit.getAverageTickTime(),
                percentileMs(ticks, 0.95),
                percentileMs(ticks, 1),
                Bukkit.getOnlinePlayers().size(),
                chunks,
                entities,
                (runtime.totalMemory() - runtime.freeMemory()) >> 20,
                runtime.maxMemory() >> 20,
                Math.max(0, gc - gcMsBefore)));
        gcMsBefore = gc;
    }

    /** The `q` quantile of tick times given in nanoseconds, in milliseconds; 0 with none. */
    static double percentileMs(long[] nanos, double q) {
        if (nanos == null || nanos.length == 0) return 0;
        long[] sorted = nanos.clone();
        Arrays.sort(sorted);
        int at = (int) Math.ceil(q * sorted.length) - 1;
        return sorted[Math.max(0, Math.min(sorted.length - 1, at))] / 1_000_000.0;
    }

    /** Milliseconds every collector has spent collecting since the JVM started. */
    private static long gcMs() {
        long total = 0;
        for (GarbageCollectorMXBean collector : ManagementFactory.getGarbageCollectorMXBeans())
            total += Math.max(0, collector.getCollectionTime());
        return total;
    }
}
