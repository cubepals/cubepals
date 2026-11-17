// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class RoundsTest {
    private static final long NEVER = Long.MAX_VALUE;

    @Test
    void blocksAreTickedInRoundsNotOneAfterAnother() {
        List<String> order = new ArrayList<>();
        Rounds<String> rounds = new Rounds<>(at -> {
            order.add(at);
            return new Rounds.Outcome<>(at, false);
        }, part -> {});
        rounds.add("a", 3, false, Part.WORLD);
        rounds.add("b", 2, false, Part.WORLD);
        rounds.add("c", 1, false, Part.WORLD);
        assertTrue(rounds.step(NEVER));
        assertEquals(List.of("a", "b", "c", "a", "b", "a"), order);
    }

    @Test
    void aBlockThatTakesNoMoreTicksStopsAndCountsWhereItChanged() {
        List<Part> changed = new ArrayList<>();
        int[] ticks = {0};
        Rounds<String> rounds = new Rounds<>(at -> ++ticks[0] > 2 ? null : new Rounds.Outcome<>(at, true), changed::add);
        rounds.add("crop", 500, false, Part.PLANTS);
        assertTrue(rounds.step(NEVER));
        assertEquals(3, ticks[0]);
        assertEquals(List.of(Part.PLANTS), changed);
    }

    @Test
    void aSpreadingBlockWithNothingToSpreadToIsGivenUpOn() {
        int[] ticks = {0};
        Rounds<String> rounds = new Rounds<>(at -> {
            ticks[0]++;
            return new Rounds.Outcome<>(at, false);
        }, part -> {});
        rounds.add("grass", 500, true, Part.WORLD);
        assertTrue(rounds.step(NEVER));
        assertEquals(RandomTicks.SETTLED, ticks[0]);
    }

    @Test
    void aBlockGoesOnAtTheTipItGrew() {
        List<Integer> at = new ArrayList<>();
        Rounds<Integer> rounds = new Rounds<>(y -> {
            at.add(y);
            return new Rounds.Outcome<>(y + 1, true);
        }, part -> {});
        rounds.add(0, 3, false, Part.PLANTS);
        assertTrue(rounds.step(NEVER));
        assertEquals(List.of(0, 1, 2), at);
    }

    @Test
    void itStopsAtTheDeadlineAndGoesOnAfter() {
        int[] ticks = {0};
        Rounds<String> rounds = new Rounds<>(at -> {
            ticks[0]++;
            return new Rounds.Outcome<>(at, false);
        }, part -> {});
        rounds.add("a", 10, false, Part.WORLD);
        assertEquals(false, rounds.step(0));
        assertEquals(0, ticks[0]);
        assertTrue(rounds.step(NEVER));
        assertEquals(10, ticks[0]);
    }
}
