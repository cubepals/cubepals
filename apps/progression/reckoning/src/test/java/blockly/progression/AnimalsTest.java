// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.SplittableRandom;
import org.junit.jupiter.api.Test;

class AnimalsTest {
    @Test
    void aBabyGrowsUpAndNoFurther() {
        assertEquals(-14_000, Animals.ageAfter(-24_000, 10_000));
        assertEquals(0, Animals.ageAfter(-24_000, 72_000));
    }

    @Test
    void aParentsWaitRunsOutAndNoFurther() {
        assertEquals(1_000, Animals.ageAfter(6_000, 5_000));
        assertEquals(0, Animals.ageAfter(6_000, 72_000));
    }

    @Test
    void aGrownAnimalStaysAsItIs() {
        assertEquals(0, Animals.ageAfter(0, 72_000));
        assertEquals(-24_000, Animals.ageAfter(-24_000, 0));
    }

    @Test
    void aShearedSheepAlmostAlwaysEatsInAnHourAndRarelyInAMinute() {
        SplittableRandom random = new SplittableRandom(3);
        int hour = 0;
        int minute = 0;
        for (int i = 0; i < 10_000; i++) {
            if (Animals.ate(72_000, false, random)) hour++;
            if (Animals.ate(1_200, false, random)) minute++;
        }
        // 1 - (499/500)^36000, and 1 - (499/500)^600: once in about 1,000 ticks.
        assertTrue(hour > 9_990, "hour " + hour);
        assertTrue(Math.abs(minute - 6_990) < 200, "minute " + minute);
    }

    @Test
    void anAnimalIsNeverMadeUpTwiceForTheSameTime() {
        long now = 1_800_000_000_000L;
        assertEquals(72_000, Animals.owedSince(72_000, null, now));
        // Made up an hour ago in another chunk: only the hour since.
        assertEquals(72_000, Animals.owedSince(144_000, now - 3_600_000, now));
        // Made up just now: nothing.
        assertEquals(0, Animals.owedSince(72_000, now, now));
        assertEquals(0, Animals.owedSince(72_000, now + 5_000, now));
    }

    @Test
    void aLambEatsSooner() {
        SplittableRandom random = new SplittableRandom(5);
        int lamb = 0;
        for (int i = 0; i < 10_000; i++) if (Animals.ate(100, true, random)) lamb++;
        // 1 - (24/25)^50 = 0.870
        assertTrue(Math.abs(lamb - 8_701) < 200, "lamb " + lamb);
        assertFalse(Animals.ate(0, true, random));
    }
}
