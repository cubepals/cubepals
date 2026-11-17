// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

/**
 * What one round of catch-up did, for the one line the server's log gets when it is done: how many
 * chunks, the longest gap among them, and the furnaces and plants that had work.
 */
final class Totals {
    int chunks;
    long longestTicks;
    int furnaces;
    int plants;
    int animals;
    int world;
    int fires;
    /** The most of one tick the work took, in nanoseconds. */
    long longestTickNanos;
    /** The average of a tick with work it took, in nanoseconds. */
    long averageTickNanos;

    void chunk(long owedTicks) {
        chunks++;
        longestTicks = Math.max(longestTicks, owedTicks);
    }

    boolean any() {
        return chunks > 0;
    }

    /**
     * The line, as `Caught up 4 chunks after up to 2h 5m: 3 furnaces, 120 plants, 2 animals, 40
     * other blocks, 0 fires; 4.8 ms of a tick on average, at most 5.1.` A furnace here is anything
     * that cooks or brews; the times are what a tick with catch-up work spent on it.
     */
    String line() {
        long minutes = longestTicks * Clock.TICK_MS / 60_000;
        String gap = minutes >= 60 ? (minutes / 60) + "h " + (minutes % 60) + "m" : minutes + "m";
        return "Caught up " + count(chunks, "chunk") + " after up to " + gap + ": " + count(furnaces, "furnace")
                + ", " + count(plants, "plant") + ", " + count(animals, "animal") + ", "
                + count(world, "other block") + ", " + count(fires, "fire") + "; " + ms(averageTickNanos)
                + " ms of a tick on average, at most " + ms(longestTickNanos) + ".";
    }

    private static double ms(long nanos) {
        return Math.round(nanos / 100_000.0) / 10.0;
    }

    private static String count(int n, String what) {
        return n + " " + what + (n == 1 ? "" : "s");
    }
}
