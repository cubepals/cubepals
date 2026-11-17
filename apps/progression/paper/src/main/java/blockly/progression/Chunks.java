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
 * a crash with the blocks it describes. A ticked chunk's is written every second, so whenever Paper
 * saves the chunk, on an unload or an autosave, the stamp saved is as new as its blocks. Writing it
 * marks the chunk for saving, so a ticked chunk is written at each autosave: a few kilobytes, for a
 * crash that never makes up time a chunk already ticked. Each world
 * also keeps the game time the plugin last saw it at, and its floor, in its own persistent data,
 * which tell a world that ran without the plugin (`Clock.floor`).
 *
 * Once a second, every loaded chunk the game ticks is moved on to now, and one that was owed a gap
 * gets its catch-up queued (`CatchUp`). A chunk that loads but isn't ticked (one at the edge of what
 * players see) owes the time until it is. A chunk has a second stamp for its animals, moved only
 * while the game ticks its entities too: the ring of chunks at the edge of the simulation distance
 * ticks blocks and not entities, and its animals are owed that time.
 */
final class Chunks implements Listener {
    static final NamespacedKey STAMP = new NamespacedKey("cubepals", "progressed");
    static final NamespacedKey SEEN = new NamespacedKey("cubepals", "progressed_game_time");
    static final NamespacedKey FLOOR = new NamespacedKey("cubepals", "progressed_floor");
    static final NamespacedKey ANIMALS = new NamespacedKey("cubepals", "progressed_animals");

    /** A chunk the plugin follows: its stamps, and the catch-up queued for it, if any. */
    private static final class Followed {
        final Chunk chunk;
        long until;
        long animalsUntil;
        CatchUp queued;
        long queuedFrom;
        long animalsQueuedFrom;

        Followed(Chunk chunk, long until, long animalsUntil) {
            this.chunk = chunk;
            this.until = until;
            this.animalsUntil = animalsUntil;
        }

        private boolean waiting() {
            return queued != null && !queued.started();
        }

        /** The stamp to keep: the one before a catch-up that never began, which is still owed. */
        long kept() {
            return waiting() ? queuedFrom : until;
        }

        long keptAnimals() {
            return waiting() ? animalsQueuedFrom : animalsUntil;
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
        PersistentDataContainer data = chunk.getPersistentDataContainer();
        Long kept = data.get(STAMP, PersistentDataType.LONG);
        Long animals = data.get(ANIMALS, PersistentDataType.LONG);
        long floor = floor(world, now);
        chunks(world).put(chunk.getChunkKey(),
                new Followed(chunk, Clock.start(kept, floor, now), Clock.start(animals != null ? animals : kept, floor, now)));
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onLoad(ChunkLoadEvent event) {
        follow(event.getChunk());
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onUnload(ChunkUnloadEvent event) {
        Chunk chunk = event.getChunk();
        Followed gone = chunks(chunk.getWorld()).remove(chunk.getChunkKey());
        if (gone != null) forget(gone);
    }

    @EventHandler(priority = EventPriority.MONITOR)
    public void onWorldUnload(WorldUnloadEvent event) {
        Map<Long, Followed> gone = followed.remove(event.getWorld());
        if (gone != null) for (Followed f : gone.values()) forget(f);
        mark(event.getWorld());
        floors.remove(event.getWorld());
    }

    /** Stamps every followed chunk as it is, for a stop: Paper saves them after plugins are disabled. */
    void stampAll() {
        for (Map.Entry<World, Map<Long, Followed>> world : followed.entrySet()) {
            for (Followed f : world.getValue().values()) stamp(f.chunk, f);
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
                Chunk.LoadLevel level = f.chunk.getLoadLevel();
                boolean blocks = level == Chunk.LoadLevel.TICKING || level == Chunk.LoadLevel.ENTITY_TICKING;
                if (!blocks) continue;
                boolean entities = level == Chunk.LoadLevel.ENTITY_TICKING;
                long owed = Clock.owedTicks(f.until, now);
                long animals = entities ? Clock.owedTicks(f.animalsUntil, now) : 0;
                if (owed > 0 || animals > 0) queue(world, f, owed, animals);
                f.until = now;
                if (entities) f.animalsUntil = now;
                stamp(f.chunk, f);
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

    /** Queues what a chunk is owed, or adds it to the catch-up already waiting for it. */
    private void queue(World world, Followed f, long owed, long animals) {
        if (f.waiting()) {
            if (!f.queued.ended()) {
                f.queued.owe(owed, animals);
                return;
            }
            // Its chunk went before it began, and came back: what it never gave is still owed.
            owed += f.queued.owed();
            animals += f.queued.animalsOwed();
        } else {
            f.queuedFrom = f.until;
            f.animalsQueuedFrom = f.animalsUntil;
        }
        f.queued = new CatchUp(world, f.chunk.getX(), f.chunk.getZ(), owed, animals, parts, cooking, ticking, totals);
        work.add(f.queued);
    }

    /**
     * Keeps an unloading chunk's stamp, and ends its queued catch-up, which belongs to that load: the
     * next load is owed from the stamp kept, and queues its own.
     */
    private static void forget(Followed f) {
        stamp(f.chunk, f);
        if (f.queued != null) f.queued.cancel();
    }

    private static void stamp(Chunk chunk, Followed f) {
        PersistentDataContainer data = chunk.getPersistentDataContainer();
        data.set(STAMP, PersistentDataType.LONG, f.kept());
        data.set(ANIMALS, PersistentDataType.LONG, f.keptAnimals());
    }

    private static void mark(World world) {
        world.getPersistentDataContainer().set(SEEN, PersistentDataType.LONG, world.getGameTime());
    }

    private Map<Long, Followed> chunks(World world) {
        return followed.computeIfAbsent(world, w -> new HashMap<>());
    }

    /** The world's floor, read once, as it is first seen, before anything marks it, and kept with it. */
    private long floor(World world, long now) {
        return floors.computeIfAbsent(world, w -> {
            PersistentDataContainer data = w.getPersistentDataContainer();
            long floor = Clock.floor(data.get(SEEN, PersistentDataType.LONG), data.get(FLOOR, PersistentDataType.LONG),
                    w.getGameTime(), now);
            if (floor != Long.MIN_VALUE) data.set(FLOOR, PersistentDataType.LONG, floor);
            return floor;
        });
    }
}
