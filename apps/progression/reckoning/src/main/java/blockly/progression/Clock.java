// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.time.Duration;

/**
 * How far each chunk's world has moved on, by the wall clock. A chunk's stamp is the moment up to
 * which the game itself ticked it: the plugin moves it to now while the chunk ticks, and a chunk
 * that ticks again after a gap is owed the gap. The gap is whatever stopped it ticking: it was
 * unloaded (its players went elsewhere, the Nether included), the server was stopped, or its
 * machine was suspended with the chunk still in memory, which nothing inside the game can see
 * except that the clock jumped.
 *
 * The wall clock, not the world's game time, since game time stands still while the server is
 * stopped or suspended, which is exactly the time owed.
 *
 * Not for what a gap does to the chunk (`CatchUp`), or for where stamps are kept (`Chunks`).
 */
final class Clock {
    /**
     * A gap shorter than this is the game's own: a chunk a player walked out of and back into, or a
     * slow tick. It is let go rather than made up, so a world played normally does no catch-up work.
     */
    static final long LEAST_MS = Duration.ofSeconds(30).toMillis();

    /** The most made up at once: a stamp from further back is a clock gone wrong, not a holiday. */
    static final long MOST_MS = Duration.ofDays(30).toMillis();

    /**
     * Game ticks a world may run without the plugin, a minute of them, before the stamps it kept are
     * no longer true: in that time the world went on without being stamped, and its stamps would
     * count that time twice.
     */
    static final long UNSEEN_TICKS = 1_200;

    /** One game tick, in milliseconds of the clock. */
    static final long TICK_MS = 50;

    private Clock() {}

    /**
     * Where a chunk's stamp starts as it loads: the one kept with it, but never before the world's
     * floor or after now. A chunk with none, never seen by the plugin, owes nothing.
     */
    static long start(Long kept, long floor, long now) {
        if (kept == null) return now;
        return Math.min(now, Math.max(kept, floor));
    }

    /**
     * The world's floor, from the game time the plugin last saw it at (`marked`) and its game time
     * as it loads: where the world ran on without the plugin, or never had it, every stamp before
     * now is untrue, so the floor is now. Otherwise there is none.
     */
    static long floor(Long marked, long gameTime, long now) {
        if (marked == null || gameTime < marked || gameTime - marked > UNSEEN_TICKS) return now;
        return Long.MIN_VALUE;
    }

    /** The game ticks owed to a chunk ticking now whose stamp is `until`: none for a short gap. */
    static long owedTicks(long until, long now) {
        long gap = now - until;
        if (gap < LEAST_MS) return 0;
        return Math.min(gap, MOST_MS) / TICK_MS;
    }
}
