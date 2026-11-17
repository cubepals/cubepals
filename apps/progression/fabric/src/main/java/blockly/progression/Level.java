// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One level's chunks as the mod follows them. A chunk is followed from the first time the game
 * ticks it, with the stamp it was kept with (`Stamps`); each tick moves it on to now, and one owed
 * a gap gets its catch-up queued (`ChunkCatchUp`). As it unloads, or the level saves, its stamp is
 * kept: grass, leaves and animals are nearly everywhere, so every chunk ticked has something. A
 * chunk loaded but never ticked (one at the edge of what players see) keeps the stamp it had: it
 * owes the time until it is ticked. A chunk has a second stamp for its animals, moved only while
 * the game ticks its entities too: the ring of chunks at the edge of the simulation distance ticks
 * blocks and not entities, and its animals are owed that time.
 */
final class Level {
    private static final Logger LOG = LoggerFactory.getLogger("CubepalsProgression");

    /** A chunk the mod follows: its stamps, and the catch-up queued for it, if any. */
    private static final class Followed {
        final LevelChunk chunk;
        long until;
        long animalsUntil;
        ChunkCatchUp queued;
        long queuedFrom;
        long animalsQueuedFrom;

        Followed(LevelChunk chunk, long until, long animalsUntil) {
            this.chunk = chunk;
            this.until = until;
            this.animalsUntil = animalsUntil;
        }

        boolean waiting() {
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

    private final ServerLevel level;
    private final Stamps stamps;
    private final long floor;
    private final Long2ObjectOpenHashMap<Followed> followed = new Long2ObjectOpenHashMap<>();
    private final Work work = new Work(System::nanoTime);
    private Totals totals = new Totals();
    private long markedAt;

    Level(ServerLevel level, long now) {
        this.level = level;
        this.stamps = level.getDataStorage().computeIfAbsent(Stamps.TYPE);
        this.floor = Clock.floor(stamps.seen(), stamps.floor(), level.getGameTime(), now);
        stamps.floorAt(floor);
    }

    void ticked(LevelChunk chunk, boolean entities, long now) {
        long key = chunk.getPos().pack();
        Followed f = followed.get(key);
        if (f == null || f.chunk != chunk) {
            Long kept = stamps.of(key);
            Long animals = stamps.animalsOf(key);
            f = new Followed(chunk, Clock.start(kept, floor, now), Clock.start(animals != null ? animals : kept, floor, now));
            followed.put(key, f);
        }
        long owed = Clock.owedTicks(f.until, now);
        long animals = entities ? Clock.owedTicks(f.animalsUntil, now) : 0;
        if (owed > 0 || animals > 0) queue(f, owed, animals);
        f.until = now;
        if (entities) f.animalsUntil = now;
    }

    /** Queues what a chunk is owed, or adds it to the catch-up already waiting for it. */
    private void queue(Followed f, long owed, long animals) {
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
        f.queued = new ChunkCatchUp(level, f.chunk, owed, animals, FabricProgression.PARTS, totals);
        work.add(f.queued);
    }

    void tickEnd(long now) {
        work.run();
        totals.longestTickNanos = Math.max(totals.longestTickNanos, work.longestSince());
        if (work.idle() && totals.any()) {
            totals.averageTickNanos = work.averageSince();
            LOG.info(totals.line());
            totals = new Totals();
        }
        // Once a second, the level is marked as seen at its game time (`Clock.floor`).
        if (now - markedAt >= 1_000) {
            markedAt = now;
            stamps.seenAt(level.getGameTime());
        }
    }

    void unloading(LevelChunk chunk) {
        Followed gone = followed.remove(chunk.getPos().pack());
        if (gone != null && gone.chunk == chunk) keep(gone);
    }

    void saving() {
        for (Followed f : followed.values()) keep(f);
        stamps.seenAt(level.getGameTime());
    }

    private void keep(Followed f) {
        stamps.keep(f.chunk.getPos().pack(), f.kept(), f.keptAnimals());
    }
}
