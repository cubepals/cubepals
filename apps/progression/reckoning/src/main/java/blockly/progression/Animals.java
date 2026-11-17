// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.random.RandomGenerator;

/**
 * What a gap does to animals, which unlike blocks aren't changed by random ticks but by their own
 * tick, too much of which (walking, pathfinding, breeding) is a world of its own to run again. So
 * only two things are made up, each by Minecraft's own rule:
 *
 * <ul>
 *   <li><b>Age.</b> A baby's age counts up to zero by one a tick, when it grows up; a parent's
 *       counts down to zero by one a tick, when it can breed again.</li>
 *   <li><b>Wool.</b> A sheared sheep grows its wool back by eating grass: every other tick its
 *       eat-grass goal is tried, and starts one time in 500 for a grown sheep, one in 25 for a
 *       lamb (half of its 1,000 and 50, since it is tried half as often), so once in 1,000 ticks
 *       and once in 50. Whether it ate at least once over a gap is drawn from that, an idea
 *       Unloaded Activity's sheep had first; it eats whether or not `mobGriefing` lets the grass
 *       go.</li>
 * </ul>
 *
 * An animal keeps the moment it was last made up to (`Herds`), so one that walked from a chunk
 * already made up into another is never made up twice for the same time (`owedSince`). Not for
 * which animals or where (each platform's `Herds`), nor breeding, which needs two animals and a
 * player's food.
 */
final class Animals {
    /** How often a sheep's eat-grass goal is tried: every other tick. */
    static final int TRIED_EVERY = 2;

    private Animals() {}

    /** An animal's age after `owed` ticks: a baby grows towards zero, a parent's wait runs out. */
    static int ageAfter(int age, long owed) {
        if (owed <= 0 || age == 0) return age;
        return age < 0 ? (int) Math.min(0L, age + owed) : (int) Math.max(0L, age - owed);
    }

    /**
     * The ticks an animal is owed: its chunk's, but never from before the animal was last made up
     * to (`madeUpTo`, the wall clock; null for one never made up).
     */
    static long owedSince(long owed, Long madeUpTo, long now) {
        if (madeUpTo == null) return owed;
        return Math.max(0, Math.min(owed, (now - madeUpTo) / Clock.TICK_MS));
    }

    /** Whether a sheep ate grass at least once over `owed` ticks. */
    static boolean ate(long owed, boolean baby, RandomGenerator random) {
        if (owed <= 0) return false;
        double once = 1.0 / (baby ? 25 : 500);
        double never = Math.pow(1 - once, (double) owed / TRIED_EVERY);
        return random.nextDouble() >= never;
    }
}
