// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.SplittableRandom;
import org.junit.jupiter.api.Test;

class RandomTicksTest {
    private static double meanOf(long ticks, int speed) {
        SplittableRandom random = new SplittableRandom(7);
        long sum = 0;
        int draws = 20_000;
        for (int i = 0; i < draws; i++) sum += RandomTicks.count(ticks, speed, random);
        return (double) sum / draws;
    }

    @Test
    void anHourAtTheDefaultSpeedIsAboutFiftyThreeRandomTicks() {
        // 72,000 game ticks x 3 / 4096 = 52.7
        double mean = meanOf(72_000, 3);
        assertTrue(Math.abs(mean - 52.73) < 0.5, "mean " + mean);
    }

    @Test
    void aShortGapIsDrawnExactly() {
        // 2,000 game ticks x 3 / 4096 = 1.46
        double mean = meanOf(2_000, 3);
        assertTrue(Math.abs(mean - 1.465) < 0.05, "mean " + mean);
    }

    @Test
    void aWorldWithGrowthTurnedOffGrowsNothing() {
        assertEquals(0, RandomTicks.count(72_000, 0, new SplittableRandom(1)));
    }

    @Test
    void aFasterWorldGrowsFaster() {
        double mean = meanOf(72_000, 30);
        assertTrue(Math.abs(mean - 527.3) / 527.3 < 0.05 || mean == RandomTicks.MOST, "mean " + mean);
    }

    @Test
    void aWeekIsCapped() {
        assertEquals(RandomTicks.MOST, RandomTicks.count(7 * 24 * 72_000L, 3, new SplittableRandom(1)));
    }

    @Test
    void noTimeIsNoTicks() {
        assertEquals(0, RandomTicks.count(0, 3, new SplittableRandom(1)));
        assertEquals(0, RandomTicks.count(-5, 3, new SplittableRandom(1)));
    }
}
