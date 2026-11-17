// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.function.LongSupplier;

/**
 * Catch-up work, done a little each tick within a budget, so a world that wakes owing hours spreads
 * the work over the ticks after rather than stalling the one a player joins on. A job is asked to
 * step until the budget is spent, and says when it is done; one not done is asked again next tick.
 *
 * Not for what a job does (`CatchUp`).
 */
final class Work {
    /** One piece of work, done in steps. */
    interface Job {
        /**
         * Does some of the work, stopping once `deadline` (of `System.nanoTime`) passes; true when
         * done. False also when it is waiting for something (a chunk's animals to load), so the
         * jobs behind it go on.
         */
        boolean step(long deadline);
    }

    /** What a tick may spend: a tenth of its 50 milliseconds. */
    static final long BUDGET_NANOS = Duration.ofMillis(5).toNanos();

    private final ArrayDeque<Job> jobs = new ArrayDeque<>();
    private final LongSupplier nanos;
    private long longest;
    private long spent;
    private long ticks;

    Work(LongSupplier nanos) {
        this.nanos = nanos;
    }

    void add(Job job) {
        jobs.add(job);
    }

    boolean idle() {
        return jobs.isEmpty();
    }

    /**
     * Steps the jobs in order until the tick's budget is spent: one done leaves the queue, one not
     * done goes to its back, and each is stepped at most once a tick.
     */
    void run() {
        if (jobs.isEmpty()) return;
        long start = nanos.getAsLong();
        long deadline = start + BUDGET_NANOS;
        for (int left = jobs.size(); left > 0 && nanos.getAsLong() < deadline; left--) {
            Job job = jobs.poll();
            if (!job.step(deadline)) jobs.add(job);
        }
        long took = nanos.getAsLong() - start;
        longest = Math.max(longest, took);
        spent += took;
        ticks++;
    }

    /** The average a tick with work spent on it since this was last asked, in nanoseconds; and starts again. */
    long averageSince() {
        long was = ticks == 0 ? 0 : spent / ticks;
        spent = 0;
        ticks = 0;
        return was;
    }

    /** The longest a tick spent on the work since this was last asked, in nanoseconds; and starts again. */
    long longestSince() {
        long was = longest;
        longest = 0;
        return was;
    }
}
