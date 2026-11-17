// SPDX-FileCopyrightText: 2026 The Cubepals Authors
//
// SPDX-License-Identifier: AGPL-3.0-only

package blockly.progression;

import java.util.ArrayList;
import java.util.List;

/**
 * A chunk's random ticks for a gap, given in rounds: each block's count is drawn first
 * (`RandomTicks`), then each round gives every block that has ticks left one of them, until none
 * has. Minecraft spreads a block's random ticks across time among its neighbours'; giving one block
 * all of its before the next would let it run ahead of them, which matters where a block's chance
 * depends on its neighbours: copper ages only where no copper within four blocks is less aged, so
 * one block ticked through first would age a whole build a stage at a time. (Unloaded Activity
 * steps such groups together for the same reason; the idea is theirs.)
 *
 * A block that no longer takes ticks stops (`Ticker.tick` returns null); one that spreads stops
 * after a run of ticks that changed nothing (`RandomTicks.SETTLED`); one that grew a new tip goes
 * on at the tip. Done in steps within a tick's budget (`Work`).
 *
 * @param <P> where a block is, on the platform
 */
final class Rounds<P> implements Work.Job {
    /** One random tick, the game's own, of the block at a place. */
    interface Ticker<P> {
        /**
         * Ticks the block at `at`: where it goes on from (`at`, or the new tip it grew) and whether
         * anything changed; null where the block no longer takes random ticks of a part that is on.
         */
        Outcome<P> tick(P at);
    }

    record Outcome<P>(P at, boolean changed) {}

    /** What is told of each block as it finishes, where it changed: its part, for the log's counts. */
    interface Done {
        void changed(Part part);
    }

    private static final class Entry<P> {
        P at;
        int left;
        final boolean spreads;
        final Part part;
        int unchanged;
        boolean changed;

        Entry(P at, int left, boolean spreads, Part part) {
            this.at = at;
            this.left = left;
            this.spreads = spreads;
            this.part = part;
        }
    }

    private final List<Entry<P>> active = new ArrayList<>();
    private final Ticker<P> ticker;
    private final Done done;
    private int index;

    Rounds(Ticker<P> ticker, Done done) {
        this.ticker = ticker;
        this.done = done;
    }

    /** A block and the random ticks drawn for it. */
    void add(P at, int ticks, boolean spreads, Part part) {
        if (ticks > 0) active.add(new Entry<>(at, ticks, spreads, part));
    }

    @Override
    public boolean step(long deadline) {
        while (true) {
            if (index >= active.size()) {
                active.removeIf(entry -> entry.left <= 0);
                index = 0;
                if (active.isEmpty()) return true;
            }
            if (System.nanoTime() >= deadline) return false;
            Entry<P> entry = active.get(index++);
            if (entry.left <= 0) continue;
            entry.left--;
            Outcome<P> outcome = ticker.tick(entry.at);
            if (outcome == null) {
                finish(entry);
                continue;
            }
            entry.at = outcome.at();
            if (outcome.changed()) {
                entry.changed = true;
                entry.unchanged = 0;
            } else if (entry.spreads && ++entry.unchanged >= RandomTicks.SETTLED) {
                finish(entry);
                continue;
            }
            if (entry.left == 0) finish(entry);
        }
    }

    private void finish(Entry<P> entry) {
        entry.left = 0;
        if (entry.changed) done.changed(entry.part);
    }
}
