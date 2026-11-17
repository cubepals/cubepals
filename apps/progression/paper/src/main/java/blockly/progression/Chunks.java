// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.function.LongSupplier;
import org.bukkit.Chunk;
import org.bukkit.NamespacedKey;
import org.bukkit.World;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.world.ChunkLoadEvent;
import org.bukkit.event.world.ChunkUnloadEvent;
import org.bukkit.event.world.WorldUnloadEvent;
import org.bukkit.persistence.PersistentDataContainer;
import org.bukkit.persistence.PersistentDataType;

/**
 * Each loaded chunk's stamp (`Clock`), kept with the chunk while it is unloaded, in its own
 * persistent data, which Paper saves in the chunk's file: so a stamp survives an unload, a stop and
 * a crash with the blocks it describes. Each world also keeps the game time the plugin last saw it
 * at, in its own persistent data, which tells a world that ran without the plugin (`Clock.floor`).
 *
 * Once a second, every loaded chunk the game ticks is moved on to now, and one that was owed a gap
 * gets its catch-up queued (`CatchUp`). A chunk that loads but isn't ticked (one at the edge of what
 * players see) owes the time until it is.
 */
final class Chunks implements Listener {
    static final NamespacedKey STAMP = new NamespacedKey("cubepals", "progressed");
    static final NamespacedKey SEEN = new NamespacedKey("cubepals", "progressed_game_time");

    /** A chunk the plugin follows: its stamp, and the catch-up queued for it, if any. */
    private static final class Followed {
        final Chunk chunk;
        long until;
        CatchUp queued;
        long queuedFrom;

        Followed(Chunk chunk, long until) {
            this.chunk = chunk;
            this.until = until;
        }

        /** The stamp to keep: the one before a catch-up that never began, which is still owed. */
        long kept() {
            return queued != null && !queued.started() ? queuedFrom : until;
        }
    }

    private final Map<World, Long> floors = new HashMap<>();
    private final Map<World, Map<Long, Followed>> followed = new HashMap<>();
    private final LongSupplier clock;
    private final Work work;
    private final Set<Part> parts;
    private final RandomTicking ticking = new RandomTicking(new Classes());
    private Cooking cooking;
    private Totals totals = new Totals();

    Chunks(LongSupplier clock, Work work, Set<Part> parts) {
        this.clock = clock;
        this.work = work;
        this.parts = parts;
    }

    /** Sorts every kind of block by part now, as the server starts (`Classes.warm`); how many. */
    int warm() {
        return ticking.warm();
    }

    /** Furnaces and the like are caught up once their ticks are found, and not where they aren't (`Cooking.find`). */
    void useCooking(Cooking found) {
        cooking = found;
    }

    /** Follows a chunk from now on: one loaded before the plugin, or by an event. */
    void follow(Chunk chunk) {
        World world = chunk.getWorld();
        long now = clock.getAsLong();
        Long kept = chunk.getPersistentDataContainer().get(STAMP, PersistentDataType.LONG);
        long until = Clock.start(kept, floor(world, now), now);
        chunks(world).put(chunk.getChunkKey(), new Followed(chunk, until));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onLoad(ChunkLoadEvent event) {
        follow(event.getChunk());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onUnload(ChunkUnloadEvent event) {
        Chunk chunk = event.getChunk();
        Followed gone = chunks(chunk.getWorld()).remove(chunk.getChunkKey());
        if (gone != null) stamp(chunk, gone.kept());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onWorldUnload(WorldUnloadEvent event) {
        Map<Long, Followed> gone = followed.remove(event.getWorld());
        if (gone != null) for (Followed f : gone.values()) stamp(f.chunk, f.kept());
        mark(event.getWorld());
        floors.remove(event.getWorld());
    }

    /** Stamps every followed chunk as it is, for a stop: Paper saves them after plugins are disabled. */
    void stampAll() {
        for (Map.Entry<World, Map<Long, Followed>> world : followed.entrySet()) {
            for (Followed f : world.getValue().values()) stamp(f.chunk, f.kept());
            mark(world.getKey());
        }
    }

    /**
     * Once a second: moves every ticked chunk on to now, queueing what a gap owes it, and marks each
     * world as seen at its game time.
     */
    void pass() {
        long now = clock.getAsLong();
        for (Map.Entry<World, Map<Long, Followed>> entry : followed.entrySet()) {
            World world = entry.getKey();
            mark(world);
            for (Followed f : entry.getValue().values()) {
                if (!ticked(f.chunk)) continue;
                long owed = Clock.owedTicks(f.until, now);
                if (owed > 0) {
                    f.queuedFrom = f.until;
                    f.queued = new CatchUp(world, f.chunk.getX(), f.chunk.getZ(), owed, parts, cooking, ticking, totals);
                    work.add(f.queued);
                }
                f.until = now;
            }
        }
    }

    /** The round of catch-up just finished, for its line in the log; null while none has run. */
    Totals finished() {
        totals.longestTickNanos = Math.max(totals.longestTickNanos, work.longestSince());
        if (!work.idle() || !totals.any()) return null;
        totals.averageTickNanos = work.averageSince();
        Totals done = totals;
        totals = new Totals();
        return done;
    }

    private static boolean ticked(Chunk chunk) {
        Chunk.LoadLevel level = chunk.getLoadLevel();
        return level == Chunk.LoadLevel.TICKING || level == Chunk.LoadLevel.ENTITY_TICKING;
    }

    private static void stamp(Chunk chunk, long until) {
        chunk.getPersistentDataContainer().set(STAMP, PersistentDataType.LONG, until);
    }

    private static void mark(World world) {
        world.getPersistentDataContainer().set(SEEN, PersistentDataType.LONG, world.getGameTime());
    }

    private Map<Long, Followed> chunks(World world) {
        return followed.computeIfAbsent(world, w -> new HashMap<>());
    }

    /** The world's floor, read once, as it is first seen, before anything marks it. */
    private long floor(World world, long now) {
        return floors.computeIfAbsent(world, w -> {
            PersistentDataContainer data = w.getPersistentDataContainer();
            return Clock.floor(data.get(SEEN, PersistentDataType.LONG), w.getGameTime(), now);
        });
    }
}
