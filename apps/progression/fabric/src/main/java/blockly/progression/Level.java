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
 * owes the time until it is ticked.
 */
final class Level {
    private static final Logger LOG = LoggerFactory.getLogger("CubepalsProgression");

    /** A chunk the mod follows: its stamp, and the catch-up queued for it, if any. */
    private static final class Followed {
        final LevelChunk chunk;
        long until;
        ChunkCatchUp queued;
        long queuedFrom;

        Followed(LevelChunk chunk, long until) {
            this.chunk = chunk;
            this.until = until;
        }

        /** The stamp to keep: the one before a catch-up that never began, which is still owed. */
        long kept() {
            return queued != null && !queued.started() ? queuedFrom : until;
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
        this.floor = Clock.floor(stamps.seen(), level.getGameTime(), now);
    }

    void ticked(LevelChunk chunk, long now) {
        long key = chunk.getPos().pack();
        Followed f = followed.get(key);
        if (f == null || f.chunk != chunk) {
            f = new Followed(chunk, Clock.start(stamps.of(key), floor, now));
            followed.put(key, f);
        }
        long owed = Clock.owedTicks(f.until, now);
        if (owed > 0) {
            f.queuedFrom = f.until;
            f.queued = new ChunkCatchUp(level, chunk, owed, FabricProgression.PARTS, totals);
            work.add(f.queued);
        }
        f.until = now;
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
        stamps.keep(f.chunk.getPos().pack(), f.kept());
    }
}
