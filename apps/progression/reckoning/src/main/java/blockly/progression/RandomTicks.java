// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.random.RandomGenerator;

/**
 * How many random ticks one block would have had over a gap. Each game tick Minecraft picks
 * `randomTickSpeed` blocks, with replacement, in every 16×16×16 section of a ticking chunk, so one
 * block is picked `speed / 4096` times a tick on average and the count over a gap is Poisson. A
 * plant given that many of its own random ticks grows as it would have, by its own rules.
 *
 * Capped, since every plant is done long before: the slowest, a crop on dry farmland halved by its
 * neighbours, needs about 180 on average to grow fully.
 */
final class RandomTicks {
    /** Blocks in a section. */
    static final int SECTION = 16 * 16 * 16;

    /** The most random ticks given to one block at once. */
    static final int MOST = 512;

    /**
     * Random ticks in a row that changed nothing, after which a block that spreads (`Part.spreads`)
     * is taken to have nothing left to spread to: grass beside nothing but grass. A neighbour one
     * of its ticks could reach is missed this long with a chance of about one in four hundred.
     */
    static final int SETTLED = 64;

    /** Below this mean, a count is drawn exactly; above, from the normal it tends to. */
    private static final double EXACT_BELOW = 30;

    private RandomTicks() {}

    /** A draw of the random ticks one block had over `ticks` game ticks, at `speed`. */
    static int count(long ticks, int speed, RandomGenerator random) {
        if (ticks <= 0 || speed <= 0) return 0;
        double mean = (double) ticks * speed / SECTION;
        if (mean - 6 * Math.sqrt(mean) > MOST) return MOST;
        long drawn = mean < EXACT_BELOW ? exact(mean, random) : Math.round(mean + Math.sqrt(mean) * random.nextGaussian());
        return (int) Math.max(0, Math.min(MOST, drawn));
    }

    /** Knuth's: multiply uniforms until the product falls below e^-mean. */
    private static long exact(double mean, RandomGenerator random) {
        double limit = Math.exp(-mean);
        double product = random.nextDouble();
        long k = 0;
        while (product > limit) {
            k++;
            product *= random.nextDouble();
        }
        return k;
    }
}
