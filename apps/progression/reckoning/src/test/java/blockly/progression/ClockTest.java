// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.time.Duration;
import org.junit.jupiter.api.Test;

class ClockTest {
    private static final long NOW = 1_800_000_000_000L;
    private static final long HOUR = Duration.ofHours(1).toMillis();

    @Test
    void aChunkNeverStampedOwesNothing() {
        assertEquals(NOW, Clock.start(null, Long.MIN_VALUE, NOW));
    }

    @Test
    void aStampedChunkOwesTheTimeSinceItsStamp() {
        long until = Clock.start(NOW - 2 * HOUR, Long.MIN_VALUE, NOW);
        assertEquals(2 * HOUR / Clock.TICK_MS, Clock.owedTicks(until, NOW));
    }

    @Test
    void aWorldThatRanWithoutThePluginOwesNothingFromBefore() {
        long floor = Clock.floor(1_000L, 1_000L + Clock.UNSEEN_TICKS + 1, NOW);
        assertEquals(0, Clock.owedTicks(Clock.start(NOW - 2 * HOUR, floor, NOW), NOW));
    }

    @Test
    void aWorldNeverMarkedOwesNothingFromBefore() {
        long floor = Clock.floor(null, 50_000L, NOW);
        assertEquals(0, Clock.owedTicks(Clock.start(NOW - 2 * HOUR, floor, NOW), NOW));
    }

    @Test
    void aWorldStoppedWithThePluginKeepsItsStamps() {
        // Marked a second before the stop; the world's game time stood still while it was stopped.
        long floor = Clock.floor(1_000L, 1_020L, NOW);
        assertEquals(2 * HOUR / Clock.TICK_MS, Clock.owedTicks(Clock.start(NOW - 2 * HOUR, floor, NOW), NOW));
    }

    @Test
    void aWorldWhoseGameTimeWentBackOwesNothingFromBefore() {
        long floor = Clock.floor(5_000L, 1_000L, NOW);
        assertEquals(0, Clock.owedTicks(Clock.start(NOW - HOUR, floor, NOW), NOW));
    }

    @Test
    void aShortGapIsTheGamesOwn() {
        assertEquals(0, Clock.owedTicks(NOW - Clock.LEAST_MS + 1, NOW));
        assertEquals(Clock.LEAST_MS / Clock.TICK_MS, Clock.owedTicks(NOW - Clock.LEAST_MS, NOW));
    }

    @Test
    void aStampInTheFutureOwesNothing() {
        assertEquals(0, Clock.owedTicks(Clock.start(NOW + HOUR, Long.MIN_VALUE, NOW), NOW));
    }

    @Test
    void aGapIsMadeUpOnlyToTheMost() {
        assertEquals(Clock.MOST_MS / Clock.TICK_MS, Clock.owedTicks(NOW - 400 * 24 * HOUR, NOW));
    }
}
