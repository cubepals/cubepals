// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class TotalsTest {
    @Test
    void theLineSaysWhatWasCaughtUp() {
        Totals totals = new Totals();
        totals.chunk(72_000 * 2 + 6_000);
        totals.chunk(1_200);
        totals.furnaces = 1;
        totals.plants = 120;
        totals.animals = 2;
        totals.world = 40;
        totals.longestTickNanos = 5_120_000;
        totals.averageTickNanos = 4_800_000;
        assertEquals(
                "Caught up 2 chunks after up to 2h 5m: 1 furnace, 120 plants, 2 animals, 40 other blocks, 0 fires;"
                        + " 4.8 ms of a tick on average, at most 5.1.",
                totals.line());
    }
}
