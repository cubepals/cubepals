// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class WorkTest {
    @Test
    void aTickSpendsNoMoreThanItsBudget() {
        AtomicLong nanos = new AtomicLong();
        Work work = new Work(nanos::get);
        int[] steps = {0};
        // A job of ten pieces, each a millisecond, done until the deadline as every job does.
        work.add(deadline -> {
            while (nanos.get() < deadline) {
                nanos.addAndGet(1_000_000);
                if (++steps[0] == 10) return true;
            }
            return false;
        });
        work.run();
        assertEquals(5, steps[0]);
        assertFalse(work.idle());
        assertEquals(5_000_000, work.longestSince());
        assertEquals(0, work.longestSince());
        work.run();
        assertEquals(10, steps[0]);
        assertTrue(work.idle());
    }

    @Test
    void aJobWaitingForSomethingLetsTheOthersGoOn() {
        AtomicLong nanos = new AtomicLong();
        Work work = new Work(nanos::get);
        int[] waited = {0};
        StringBuilder done = new StringBuilder();
        work.add(deadline -> ++waited[0] > 3);
        work.add(deadline -> done.append('b') != null);
        work.run();
        // The waiting job was asked once, then the next ran; neither spun the budget.
        assertEquals(1, waited[0]);
        assertEquals("b", done.toString());
        work.run();
        work.run();
        work.run();
        assertTrue(work.idle());
    }

    @Test
    void jobsRunInTheOrderTheyCame() {
        AtomicLong nanos = new AtomicLong();
        Work work = new Work(nanos::get);
        StringBuilder order = new StringBuilder();
        work.add(deadline -> order.append('a') != null);
        work.add(deadline -> order.append('b') != null);
        work.run();
        assertEquals("ab", order.toString());
    }
}
